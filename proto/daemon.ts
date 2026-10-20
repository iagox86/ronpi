// ronpid M0 skeleton: owns pi RPC children, bridges them to controllers over
// a unix socket. Killing a controller never touches the children.
//
// Run: node daemon.ts   (from a shell where `node` is v26 and PATH includes
// its bin/; children inherit this env, including pi settings/auth.)
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { LineSplitter, encodeLine, type ClientCommand, type DaemonMessage, type TabMeta } from "./shared.ts";

const PI_CLI =
	"/var/home/ron/.nvm/versions/node/v26.12.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

const AUTOSPAWN = Number.parseInt(process.env.RONPI_AUTOSPAWN ?? "2", 10);
const SOCK = process.env.RONPI_SOCK ?? `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/ronpi.sock`;
const DEFAULT_CWD = process.env.RONPI_CWD ?? process.cwd();
const LOG = process.env.RONPI_LOG ?? path.join(import.meta.dirname, "daemon.log");

// Extension dialog methods block the child until answered; the rest are
// fire-and-forget (notify/setStatus/setWidget/setTitle/set_editor_text).
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function log(msg: string): void {
	try {
		fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// logging must never take the daemon down
	}
}

class Child {
	id: number;
	cwd: string;
	meta: TabMeta;
	client: RpcClient;

	constructor(id: number, cwd: string) {
		this.id = id;
		this.cwd = cwd;
		this.client = new RpcClient({ cliPath: PI_CLI, cwd });
		this.meta = {
			id,
			cwd,
			name: path.basename(cwd),
			model: "loading",
			messageCount: 0,
			streaming: false,
			dead: false,
			pendingDialog: false,
		};
	}

	async refreshMeta(): Promise<void> {
		try {
			const s = await this.client.getState();
			this.meta.model = s.model ? `${s.model.provider}/${s.model.id}` : "default";
			this.meta.sessionId = s.sessionId;
			this.meta.sessionFile = s.sessionFile;
			this.meta.messageCount = s.messageCount;
			this.meta.streaming = s.isStreaming;
			this.meta.name = s.sessionName ?? path.basename(this.cwd);
			this.meta.dead = false;
		} catch (err) {
			this.meta.dead = true;
			this.meta.streaming = false;
			log(`tab ${this.id} refreshMeta failed: ${err}`);
		}
	}
}

const children = new Map<number, Child>();
let nextId = 1;
const clients = new Set<net.Socket>();
let shuttingDown = false;

function broadcast(msg: DaemonMessage): void {
	const line = encodeLine(msg);
	for (const socket of clients) {
		socket.write(line);
	}
}

function broadcastTabs(): void {
	const tabs = [...children.values()].map((child) => child.meta);
	broadcast({ type: "tabs", tabs });
	log(`tabs: ${tabs.map((t) => `${t.id}:${t.name}${t.streaming ? "*" : ""}${t.dead ? "x" : ""}`).join(" ")}`);
}

function onChildEvent(child: Child, event: Record<string, unknown>): void {
	const type = event.type as string;
	if (type === "extension_ui_request") {
		if (DIALOG_METHODS.has(event.method as string)) {
			child.meta.pendingDialog = true;
			broadcastTabs();
		}
		broadcast({ type: "ui_request", tab: child.id, request: event });
		return;
	}
	broadcast({ type: "event", tab: child.id, event });
	if (type === "message_start" || type === "message_end" || type === "agent_start" || type === "agent_settled") {
		log(`tab ${child.id} event: ${type}${type === "message_end" ? ` stop=${(event.message as { stopReason?: string })?.stopReason}` : ""}`);
	}
	if (type === "agent_start") {
		child.meta.streaming = true;
		broadcastTabs();
	} else if (type === "agent_settled") {
		child.meta.streaming = false;
		void child.refreshMeta().then(broadcastTabs);
	}
}

async function spawnChild(cwd: string): Promise<Child> {
	const child = new Child(nextId++, cwd);
	children.set(child.id, child);
	child.client.onEvent((event) => onChildEvent(child, event as Record<string, unknown>));
	await child.client.start();
	await child.refreshMeta();
	log(`spawned tab ${child.meta.id} cwd=${cwd}`);
	broadcastTabs();
	return child;
}

function handleClientCommand(socket: net.Socket, cmd: ClientCommand): void {
	const child = "tab" in cmd ? children.get(cmd.tab) : undefined;
	if ("tab" in cmd && !child) {
		log(`command for unknown tab ${cmd.tab}: ${cmd.type}`);
		return;
	}
	switch (cmd.type) {
		case "prompt": {
			if (child.meta.dead) {
				log(`prompt to dead tab ${cmd.tab} dropped`);
				return;
			}
			void child.client.prompt(cmd.message).catch((err) => log(`prompt tab ${cmd.tab} failed: ${err}`));
			break;
		}
		case "abort": {
			void child.client.abort().catch((err) => log(`abort tab ${cmd.tab} failed: ${err}`));
			break;
		}
		case "spawn": {
			void spawnChild(cmd.cwd ?? DEFAULT_CWD).catch((err) => log(`spawn failed: ${err}`));
			break;
		}
		case "ui_response": {
			const response = cmd.response ?? {};
			if (typeof response.id !== "string") {
				log(`ui_response without id on tab ${cmd.tab}`);
				return;
			}
			child.meta.pendingDialog = false;
			broadcastTabs();
			const record = { type: "extension_ui_response", ...response };
			void (child.client as unknown as { send(c: unknown): Promise<void> }).send(record)
				.catch((err: unknown) => log(`ui_response tab ${cmd.tab} failed: ${err}`));
			break;
		}
	}
}

const server = net.createServer((socket) => {
	clients.add(socket);
	const splitter = new LineSplitter();
	socket.on("data", (chunk: Buffer) => {
		for (const line of splitter.push(chunk.toString("utf8"))) {
			try {
				handleClientCommand(socket, JSON.parse(line) as ClientCommand);
			} catch (err) {
				log(`bad client line: ${err}`);
			}
		}
	});
	socket.on("error", () => {});
	socket.on("close", () => clients.delete(socket));

	// Initial sync: current tab list + transcript replay for each child.
	socket.write(encodeLine({ type: "tabs", tabs: [...children.values()].map((c) => c.meta) } satisfies DaemonMessage));
	for (const child of children.values()) {
		void child.client
			.getMessages()
			.then((messages) => socket.write(encodeLine({ type: "history", tab: child.id, messages } satisfies DaemonMessage)))
			.catch((err) => log(`history tab ${child.id} failed: ${err}`));
	}
	log(`controller attached (${clients.size} connected)`);
});

async function main(): Promise<void> {
	log("daemon starting");
	fs.rmSync(SOCK, { force: true });
	await new Promise<void>((resolve) => server.listen(SOCK, resolve));
	log(`listening on ${SOCK}`);

	for (let i = 0; i < AUTOSPAWN; i++) {
		try {
			await spawnChild(DEFAULT_CWD);
		} catch (err) {
			log(`autosSpawn ${i + 1} failed: ${err}`);
		}
	}

	// Liveness poll: marks children dead if their process exits.
	const poller = setInterval(() => {
		for (const child of children.values()) {
			void child.refreshMeta().then(broadcastTabs);
		}
	}, 15_000);
	poller.unref();
}

function shutdown(): void {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	log("daemon shutting down");
	server.close();
	for (const child of children.values()) {
		void child.client.stop().catch(() => {});
	}
	fs.rmSync(SOCK, { force: true });
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await main();
