// ronpi M0 controller: a TUI over the daemon socket. Dumb by design - it
// renders, switches, and prompts; the daemon owns everything else.
//
// Run: node controller.ts
// Keys: ctrl+T next tab, ctrl+C abort (if running) else quit, enter submit.
// Permission dialogs: y/n for confirm, 1-9 for select; input/editor dialogs
// are auto-denied in M0.
import * as net from "node:net";
import {
	Container,
	Editor,
	type EditorTheme,
	isKeyRelease,
	matchesKey,
	Key,
	ProcessTerminal,
	ScrollView,
	Text,
	truncateToWidth,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	getSelectListTheme,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { LineSplitter, encodeLine, type DaemonMessage, type TabMeta } from "./shared.ts";

const SOCK = process.env.RONPI_SOCK ?? `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/ronpi.sock`;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

// The pi theme instance isn't exported from the package index, so M0 chrome
// colors are plain ANSI; real theming (solarized) comes with M1.
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const accent = (s: string) => `\x1b[36m${s}\x1b[0m`;

initTheme();
const mdTheme = getMarkdownTheme();
const editorTheme: EditorTheme = {
	borderColor: dim,
	selectList: getSelectListTheme(),
};

interface UserItem {
	kind: "user";
	component: UserMessageComponent;
}
interface AssistantItem {
	kind: "assistant";
	component: AssistantMessageComponent;
	partial: Record<string, unknown> & { content: unknown[] };
	text: Map<number, string>;
	thinking: Map<number, string>;
}
interface ToolItem {
	kind: "tool";
	component: ToolExecutionComponent;
}
interface OtherItem {
	kind: "other";
	component: Text;
}
type Item = UserItem | AssistantItem | ToolItem | OtherItem;

interface TabState {
	meta: TabMeta;
	items: Item[];
	tools: Map<string, ToolItem>;
	dialog?: Record<string, unknown> & { id: string; method: string; title?: string; message?: string; options?: string[] };
}

class InputEditor extends Editor {
	onKey?: (data: string) => boolean;

	handleInput(data: string): void {
		if (this.onKey && this.onKey(data)) {
			return;
		}
		super.handleInput(data);
	}
}

function userText(m: { content: unknown }): string {
	if (typeof m.content === "string") {
		return m.content;
	}
	if (Array.isArray(m.content)) {
		return m.content
			.filter((b) => (b as { type?: string }).type === "text")
			.map((b) => (b as { text?: string }).text ?? "")
			.join("\n");
	}
	return "";
}

class Controller {
	tui: TuiAltScreen;
	chatRoot = new Container();
	scroll: ScrollView;
	tabsLine = new Text("", 0, 0);
	statusLine = new Text("", 0, 0);
	editor: InputEditor;
	socket!: net.Socket;
	tabs = new Map<number, TabState>();
	focused = 0;
	flash = "";
	flashTimer?: ReturnType<typeof setTimeout>;

	constructor() {
		this.tui = new TuiAltScreen(new ProcessTerminal(), true);
		this.scroll = new ScrollView(this.chatRoot, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
		this.editor = new InputEditor(this.tui, editorTheme, { paddingX: 1 });
		this.editor.onSubmit = (text) => this.submit(text);
		this.editor.onKey = (data) => this.handleAppKey(data);
		// Mirror pi's fullscreen chat viewport: flexible transcript + fixed dock.
		const dock = new VStack([
			{ component: this.statusLine, shrink: 1, minSize: 0 },
			{ component: this.editor, shrink: 1, minSize: 3 },
		]);
		const root = new VStack([
			{ component: this.tabsLine },
			{ component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		this.tui.setLayoutRoot(root);
		this.tui.setFocus(this.editor);
	}

	async run(): Promise<void> {
		await this.connect();
		this.renderChrome();
		try {
			this.tui.start();
			// park the process; the TUI owns the loop from here
			await new Promise<never>(() => {});
		} finally {
			this.tui.stop();
		}
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = net.connect(SOCK);
			socket.once("connect", () => {
				this.socket = socket;
				const splitter = new LineSplitter();
				socket.on("data", (chunk: Buffer) => {
					for (const line of splitter.push(chunk.toString("utf8"))) {
						try {
							this.handleDaemonMessage(JSON.parse(line) as DaemonMessage);
						} catch (err) {
							console.error(`bad daemon line: ${err}`);
						}
					}
				});
				socket.on("close", () => this.daemonLost());
				socket.on("error", () => {});
				resolve();
			});
			socket.once("error", (err) => {
				reject(new Error(`cannot reach daemon at ${SOCK} - start it first: node daemon.ts (${err.message})`));
			});
		});
	}

	daemonLost(): void {
		process.stdout.write("\nronpi daemon disconnected; exiting.\n");
		this.dispose();
	}

	dispose(): void {
		try {
			this.tui.stop();
		} catch {
			// best effort
		}
		this.socket?.destroy();
		process.exit(0);
	}

	send(msg: Record<string, unknown>): void {
		this.socket?.write(encodeLine(msg));
	}

	submit(text: string): void {
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			return;
		}
		this.send({ type: "prompt", tab: this.focused, message: trimmed });
		this.editor.setText("");
	}

	tabState(id: number): TabState | undefined {
		return this.tabs.get(id);
	}

	focusedTab(): TabState | undefined {
		return this.tabs.get(this.focused);
	}

	handleDaemonMessage(msg: DaemonMessage): void {
		switch (msg.type) {
			case "tabs": {
				for (const meta of msg.tabs) {
					let state = this.tabs.get(meta.id);
					if (!state) {
						state = { meta, items: [], tools: new Map() };
						this.tabs.set(meta.id, state);
					}
					Object.assign(state.meta, meta);
				}
				if (this.focused === 0 && this.tabs.size > 0) {
					this.focused = Math.min(...this.tabs.keys());
				}
				if (!this.tabs.has(this.focused)) {
					this.focused = Math.min(...this.tabs.keys());
					this.rebuildChat();
				}
				this.renderChrome();
				break;
			}
			case "history": {
				const state = this.tabs.get(msg.tab);
				// only seed an empty transcript; live events may have arrived first
				if (state && state.items.length === 0 && msg.messages.length > 0) {
					state.items = itemsFromMessages(msg.messages, state.meta.cwd);
					if (msg.tab === this.focused) {
						this.rebuildChat();
					}
				}
				break;
			}
			case "event": {
				const state = this.tabs.get(msg.tab);
				if (state) {
					this.applyEvent(state, msg.event);
				}
				break;
			}
			case "ui_request": {
				const state = this.tabs.get(msg.tab);
				if (!state) {
					break;
				}
				const request = msg.request as TabState["dialog"];
				if (request && DIALOG_METHODS.has(request.method)) {
					if (request.method === "input" || request.method === "editor") {
						// M0: no free-form dialog UI; deny is the safe default
						this.send({
							type: "ui_response",
							tab: msg.tab,
							response: { type: "extension_ui_response", id: request.id, cancelled: true },
						});
					} else {
						state.dialog = request;
					}
				} else if (request && request.method === "notify") {
					this.notify(String(request.message ?? "notification"));
				}
				this.renderChrome();
				break;
			}
			case "exited": {
				const state = this.tabs.get(msg.tab);
				if (state) {
					state.meta.dead = true;
					state.meta.streaming = false;
					this.renderChrome();
				}
				break;
			}
		}
	}

	applyEvent(state: TabState, ev: Record<string, unknown>): void {
		const type = ev.type as string;
		switch (type) {
			case "message_start": {
				const m = ev.message as { role?: string; content?: unknown };
				if (m?.role === "user") {
					this.addItem(state, { kind: "user", component: new UserMessageComponent(userText(m), mdTheme, 1) });
				} else if (m?.role === "assistant") {
					const partial = m as AssistantItem["partial"];
					this.addItem(state, {
						kind: "assistant",
						component: new AssistantMessageComponent(partial as never, true, mdTheme, undefined, 1),
						partial,
						text: new Map(),
						thinking: new Map(),
					});
				}
				break;
			}
			case "message_update": {
				const item = lastAssistant(state);
				if (!item) {
					break;
				}
				this.applyDelta(item, ev.assistantMessageEvent as Record<string, unknown>);
				item.component.updateContent(item.partial as never, true);
				item.component.invalidate();
				break;
			}
			case "message_end": {
				const m = ev.message as { role?: string; stopReason?: string; content?: unknown } | undefined;
				if (m?.role === "assistant") {
					const item = lastAssistant(state);
					if (item) {
						item.partial = m as AssistantItem["partial"];
						item.component.updateContent(item.partial as never, false);
					}
					if (m.stopReason === "error") {
						const text = userText(m).trim() || "(provider error)";
						this.addItem(state, { kind: "other", component: new Text(accent(`error: ${text}`), 1, 0) });
					}
				}
				break;
			}
			case "tool_execution_start": {
				const component = new ToolExecutionComponent(
					ev.toolName as string,
					ev.toolCallId as string,
					ev.args,
					undefined,
					undefined,
					this.tui,
					state.meta.cwd,
				);
				component.markExecutionStarted();
				const item: ToolItem = { kind: "tool", component };
				this.addItem(state, item);
				state.tools.set(ev.toolCallId as string, item);
				break;
			}
			case "tool_execution_update": {
				const item = state.tools.get(ev.toolCallId as string);
				if (item) {
					item.component.updateArgs(ev.args);
					const partial = ev.partialResult as { content?: unknown } | undefined;
					if (partial) {
						item.component.updateResult({ ...partial, isError: false }, true);
					}
				}
				break;
			}
			case "tool_execution_end": {
				const item = state.tools.get(ev.toolCallId as string);
				if (item) {
					item.component.setArgsComplete();
					item.component.updateResult(ev.result as never, false);
				}
				break;
			}
			case "agent_start": {
				state.meta.streaming = true;
				this.renderChrome();
				break;
			}
			case "agent_settled": {
				state.meta.streaming = false;
				this.renderChrome();
				break;
			}
		}
		if (state.meta.id === this.focused) {
			this.scroll.scrollToEnd();
			this.tui.requestRender();
		}
	}

	// Mount new items immediately on the focused tab; rebuildChat() mounts
	// the rest of a tab's items on switch.
	addItem(state: TabState, item: Item): void {
		state.items.push(item);
		if (state.meta.id === this.focused) {
			this.chatRoot.addChild(item.component);
		}
	}

	applyDelta(item: AssistantItem, delta: Record<string, unknown>): void {
		const idx = (delta.contentIndex as number) ?? 0;
		const content = item.partial.content;
		const type = delta.type as string;
		if (type === "text_delta") {
			let block = content[idx] as { type: string; text: string } | undefined;
			if (!block || block.type !== "text") {
				block = { type: "text", text: "" };
				content[idx] = block;
			}
			block.text = (item.text.get(idx) ?? "") + (delta.delta as string);
			item.text.set(idx, block.text);
		} else if (type === "thinking_delta") {
			let block = content[idx] as { type: string; thinking: string } | undefined;
			if (!block || block.type !== "thinking") {
				block = { type: "thinking", thinking: "" };
				content[idx] = block;
			}
			block.thinking = (item.thinking.get(idx) ?? "") + (delta.delta as string);
			item.thinking.set(idx, block.thinking);
		} else if (type === "text_end" || type === "thinking_end") {
			// authoritative content replaces our reconstruction
			const block = content[idx] as { type: string; text?: string; thinking?: string } | undefined;
			if (block) {
				const finalText = delta.content as string | undefined;
				if (typeof finalText === "string") {
					if (block.type === "text") {
						block.text = finalText;
						item.text.set(idx, finalText);
					} else if (block.type === "thinking") {
						block.thinking = finalText;
						item.thinking.set(idx, finalText);
					}
				}
			}
		}
		// toolcall_* deltas are skipped: tools render from tool_execution_* events
	}

	switchTab(delta: number): void {
		const ids = [...this.tabs.keys()].sort((a, b) => a - b);
		if (ids.length === 0) {
			return;
		}
		const pos = ids.indexOf(this.focused);
		const next = pos === -1 ? ids[0] : ids[(pos + delta + ids.length) % ids.length];
		if (next === this.focused) {
			return;
		}
		this.focused = next;
		this.rebuildChat();
		this.renderChrome();
	}

	rebuildChat(): void {
		this.chatRoot.clear();
		const state = this.focusedTab();
		if (state) {
			for (const item of state.items) {
				this.chatRoot.addChild(item.component);
			}
		}
		this.scroll.scrollToEnd();
		this.tui.requestRender(true);
	}

	handleAppKey(data: string): boolean {
		if (isKeyRelease(data)) {
			return true;
		}
		if (matchesKey(data, Key.ctrl("t"))) {
			// ctrl+T (legacy, kitty, and csi-u encodings)
			this.switchTab(1);
			return true;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			// ctrl+C: abort if running, else quit
			const state = this.focusedTab();
			if (state?.meta.streaming) {
				this.send({ type: "abort", tab: this.focused });
				this.notify("abort sent");
			} else {
				this.dispose();
			}
			return true;
		}
		const state = this.focusedTab();
		if (state?.dialog) {
			return this.handleDialogKey(state, data);
		}
		return false;
	}

	handleDialogKey(state: TabState, data: string): boolean {
		const dialog = state.dialog!;
		if (dialog.method === "confirm") {
			if (data === "y") {
				this.answerDialog(state, { confirmed: true });
				return true;
			}
			if (data === "n") {
				this.answerDialog(state, { confirmed: false });
				return true;
			}
		} else if (dialog.method === "select") {
			const options = dialog.options ?? [];
			const idx = Number.parseInt(data, 10);
			if (!Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
				this.answerDialog(state, { value: options[idx - 1] });
				return true;
			}
			if (data === "\x1b") {
				this.answerDialog(state, { cancelled: true });
				return true;
			}
		}
		return false;
	}

	answerDialog(state: TabState, fields: Record<string, unknown>): void {
		this.send({
			type: "ui_response",
			tab: state.meta.id,
			response: { type: "extension_ui_response", id: state.dialog!.id, ...fields },
		});
		state.dialog = undefined;
		this.renderChrome();
	}

	notify(message: string): void {
		this.flash = message;
		this.renderChrome();
		if (this.flashTimer) {
			clearTimeout(this.flashTimer);
		}
		this.flashTimer = setTimeout(() => {
			this.flash = "";
			this.renderChrome();
		}, 4000);
	}

	renderChrome(): void {
		const width = this.tui.terminal.columns || process.stdout.columns || 80;
		const parts: string[] = [];
		for (const id of [...this.tabs.keys()].sort((a, b) => a - b)) {
			const state = this.tabs.get(id)!;
			const marker = state.meta.dead ? "x" : state.meta.pendingDialog ? "!" : state.meta.streaming ? "*" : " ";
			const focus = id === this.focused ? ">" : " ";
			parts.push(
				state.meta.streaming
					? accent(`${focus}${id}${marker} ${state.meta.name}`)
					: dim(`${focus}${id}${marker} ${state.meta.name}`),
			);
		}
		this.tabsLine.setText(truncateToWidth(parts.join("   "), width));

		const state = this.focusedTab();
		let status: string;
		if (state?.dialog) {
			const d = state.dialog;
			if (d.method === "confirm") {
				status = accent(`PERMISSION: ${d.title ?? "confirm"}${d.message ? ` - ${d.message}` : ""}  [y]es [n]o`);
			} else {
				const opts = (d.options ?? []).map((o, i) => `${i + 1}:${o}`).join("  ");
				status = accent(`PERMISSION: ${d.title ?? "select"}  ${opts}`);
			}
		} else if (this.flash) {
			status = accent(this.flash);
		} else if (state) {
			const activity = state.meta.streaming ? "working" : state.meta.dead ? "dead" : "idle";
			status = dim(`${state.meta.model} | ${activity} | ctrl+T tab, ctrl+C ${state.meta.streaming ? "abort" : "quit"}`);
		} else {
			status = dim("no tabs");
		}
		this.statusLine.setText(truncateToWidth(status, width));
		this.tui.requestRender();
	}
}

function lastAssistant(state: TabState): AssistantItem | undefined {
	for (let i = state.items.length - 1; i >= 0; i--) {
		const item = state.items[i];
		if (item.kind === "assistant") {
			return item;
		}
	}
	return undefined;
}

function itemsFromMessages(messages: unknown[], cwd: string): Item[] {
	const items: Item[] = [];
	for (const raw of messages) {
		const m = raw as { role?: string; content?: unknown };
		if (m.role === "user") {
			items.push({ kind: "user", component: new UserMessageComponent(userText(m), mdTheme, 1) });
		} else if (m.role === "assistant") {
			items.push({
				kind: "assistant",
				component: new AssistantMessageComponent(m as never, true, mdTheme, undefined, 1),
				partial: m as AssistantItem["partial"],
				text: new Map(),
				thinking: new Map(),
			});
		} else if (m.role === "toolResult") {
			items.push({ kind: "other", component: new Text(dim("(tool result)"), 1, 0) });
		}
	}
	return items;
}

function main(): void {
	const controller = new Controller();
	process.on("SIGINT", () => controller.dispose());
	process.on("SIGTERM", () => controller.dispose());
	process.on("uncaughtException", (err) => {
		try {
			controller.tui.stop();
		} catch {
			// best effort
		}
		throw err;
	});
	controller.run().catch((err) => {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	});
}

main();
