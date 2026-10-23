// ronpi controller: a TUI over the daemon socket. Dumb by design - it
// renders, switches, and prompts; the daemon owns everything else.
//
// Session view: left-arrow on an empty editor opens the switcher; /abort and
// /exit are intercepted here (never forwarded to the child); everything else
// goes to the child. No ctrl chords in the session view.
// Switcher: up/down select, enter/right open, esc closes, ctrl-n/x/r/g
// manage, command box takes /new /kill /rename /group /exit /help.
//
// Run: node controller.ts
import * as fs from "node:fs";
import * as net from "node:net";
import {
  Container,
  isKeyRelease,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  truncateToWidth,
  TuiAltScreen,
  VStack,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DIALOG_METHODS, HISTORY_FILE, SOCK } from "./config.ts";
import type { DialogRequest, } from "./dialogs.ts";
import { configureEditorKeys, InputEditor, } from "./editor.ts";
import { lastLine } from "./format.ts";
import { RewindPicker } from "./rewind-picker.ts";
import { loadCommands, mergeHistory, recordCommand, trimCommands } from "./history.ts";
import { rewindTargets } from "./rewind.ts";
import { hideThinkingBlock, wheelScrollLines } from "./pi-settings.ts";
import { SessionActions } from "./session-actions.ts";
import { SwitcherActions } from "./switcher-actions.ts";
import { ensureDaemon, killServer } from "./lifecycle.ts";
import { selectListTheme } from "./pi-theme.ts";
import {
  sessionKey,
  type LocalSession,
} from "./session-list.ts";
import { type ClientCommand, type DaemonMessage, type DistributiveOmit, encodeLine, LineSplitter, type SessionMeta } from "./shared.ts";
import { buildStatusLine, fleetStats } from "./status.ts";
import { ActivityLine } from "./activity.ts";
import { assertTruecolor, dim, OSC_RESET_BG, OSC_SET_BG } from "./theme.ts";
import { Switcher, } from "./switcher.ts";
import {
  applyEvent,
  type Item,
  itemsFromMessages,
  newView,
  type SessionView,
} from "./transcript.ts";

configureEditorKeys();
const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: selectListTheme,
};

const SWITCHER_HISTORY = "<switcher>";

class Controller {
  tui: TuiAltScreen;
  chatRoot = new Container();
  chatLayout: VStack;
  switcherLayout: VStack;
  scroll: ScrollView;
  statusLine = new Text("", 0, 0);
  activityLine = new ActivityLine();
  rewindPicker = new RewindPicker();
  /** Show full tool blocks instead of one summary line per run. */
  toolsExpanded = false;
  /** Session whose messages currently back the editor's up-arrow history. */
  private historyFor: string | null = null;
  /** Hide assistant thinking blocks (ctrl-t); starts from pi's setting. */
  thinkingHidden = hideThinkingBlock();
  private activityTimer?: ReturnType<typeof setInterval>;
  editor: InputEditor;
  switcher = new Switcher();
  socket!: net.Socket;

  /** Daemon-known sessions by daemon id. */
  sessions = new Map<number, SessionMeta>();
  /** Sessions from the filesystem (listAll), by session file path. */
  local = new Map<string, LocalSession>();
  /** Transcript state by canonical key (session file path, or daemon:N). */
  views = new Map<string, SessionView>();
  /** Last message text per session key, for the switcher description. */
  summaries = new Map<string, string>();
  /** Path key of the session on screen; null = none (switcher behind). */
  viewing: string | null = null;

  switching: SwitcherActions;
  session: SessionActions;
  /** Spawn/adopt resolved by the daemon's next session list: enter it then. */
  pendingEnterId: number | null = null;
  /** Text to send once pendingEnterId resolves (adopt-then-prompt flow). */
  pendingPrompt: string | null = null;
  private sessionsLoaded = false;
  private reqSeq = 0;
  private responses = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private flash = "";
  private flashTimer?: ReturnType<typeof setTimeout>;
  private listTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.switching = new SwitcherActions(this);
    this.session = new SessionActions(this);
    this.tui = new TuiAltScreen(new ProcessTerminal(), true, undefined, { wheelScrollLines: wheelScrollLines() });
    this.scroll = new ScrollView(this.chatRoot, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
    this.editor = new InputEditor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.debugLog = process.env.RONPI_KEYS ?? "";
    this.editor.onSubmit = (text) => this.submit(text);
    this.editor.onKey = (data) => this.keys(data);
    const dock = new VStack([
      { component: this.editor, shrink: 0, minSize: 3 },
      { component: this.statusLine, shrink: 0, minSize: 1 },
    ]);
    // Two roots over one shared dock: the chat view, and the switcher view
    // (full-screen minus the dock, so the input box is never covered).
    this.chatLayout = new VStack([
      { component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: this.activityLine, basis: "auto", grow: 0, shrink: 0, minSize: 0 },
      { component: this.rewindPicker, basis: "auto", grow: 0, shrink: 0, minSize: 0 },
      // never compress the dock: a shrunken editor was the "cut off" bug
      { component: dock, basis: "auto", grow: 0, shrink: 0, minSize: 4 },
    ]);
    this.switcherLayout = new VStack([
      { component: this.switcher, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: "auto", grow: 0, shrink: 0, minSize: 4 },
    ]);
    this.tui.setLayoutRoot(this.chatLayout);
    this.tui.setFocus(this.editor);

    this.switcher.heightProvider = () => this.tui.terminal.rows || 24;
    this.switcher.debugLog = process.env.RONPI_KEYS ?? "";
    this.switcher.onShiftSession = (delta, s) => void this.switching.moveSession(delta, s);
    this.switcher.onShiftGroup = (delta, title) => void this.switching.moveGroup(delta, title);
  }

  async run(): Promise<void> {
    trimCommands(HISTORY_FILE);
    try {
      await this.connect();
    } catch {
      await ensureDaemon();
      await this.connect();
    }
    await this.loadLocal();
    this.renderChrome();
    try {
      this.tui.start();
      // Make the terminal's own background the page color, so rows no
      // component draws into (below short transcripts, around boxes) match.
      process.stdout.write(OSC_SET_BG);
      process.on("exit", () => process.stdout.write(OSC_RESET_BG));
      this.switching.open();
      this.listTimer = setInterval(() => {
        void this.loadLocal().then(() => {
          if (this.switching.isOpen) {
            this.switching.refresh();
          }
        });
      }, 10_000);
      this.listTimer.unref?.();
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
        // Announce ourselves: the daemon classifies connections by their
        // first command (presence heartbeats vs controllers), and its
        // initial sync + broadcast membership are keyed on that. Without
        // this the controller never enters the broadcast set and misses
        // every session update until its first user-driven command.
        this.send({ type: "list" });
        const splitter = new LineSplitter();
        // Resolve only once the first session list has arrived, so the
        // initial switcher render already knows which sessions are live
        // in pi (no [pi] tag popping in a tick later). Timeout = fallback.
        let resolved = false;
        const done = () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        };
        setTimeout(done, 3000).unref?.();
        socket.on("data", (chunk: Buffer) => {
          for (const line of splitter.push(chunk.toString("utf8"))) {
            try {
              this.handleDaemonMessage(JSON.parse(line) as DaemonMessage);
            } catch (err) {
              console.error(`bad daemon line: ${err}`);
            }
          }
          if (this.sessionsLoaded) {
            done();
          }
        });
        socket.on("close", () => this.daemonLost());
        socket.on("error", () => {});
      });
      socket.once("error", (err) => {
        reject(new Error(`cannot reach daemon at ${SOCK} even after auto-start attempt (${err.message})`));
      });
    });
  }

  daemonLost(): void {
    process.stdout.write("\nronpi daemon disconnected; exiting.\n");
    this.dispose();
  }

  dispose(): void {
    process.stdout.write(OSC_RESET_BG);
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

  /** Send a command with response correlation. */
  request(cmd: DistributiveOmit<ClientCommand, "id">): Promise<unknown> {
    const id = `req-${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      this.responses.set(id, { resolve, reject });
      this.send({ ...cmd, id });
      setTimeout(() => {
        if (this.responses.has(id)) {
          this.responses.delete(id);
          reject(new Error("daemon request timed out"));
        }
      }, 30_000).unref?.();
    });
  }

  handleDaemonMessage(msg: DaemonMessage): void {
    switch (msg.type) {
      case "sessions": {
        this.sessionsLoaded = true;
        this.sessions.clear();
        for (const meta of msg.sessions) {
          this.sessions.set(meta.id, meta);
          // Migrate item keys once a session gains its file path.
          const tmpKey = `daemon:${meta.id}`;
          if (meta.sessionFile) {
            const tmpView = this.views.get(tmpKey);
            if (tmpView && !this.views.has(meta.sessionFile)) {
              this.views.set(meta.sessionFile, tmpView);
              this.views.delete(tmpKey);
            }
            if (this.viewing === tmpKey) {
              this.viewing = meta.sessionFile;
            }
          }
        }
        // Resolved spawn: enter the session we just created.
        if (this.pendingEnterId !== null && this.sessions.has(this.pendingEnterId)) {
          const meta = this.sessions.get(this.pendingEnterId)!;
          this.pendingEnterId = null;
          const queuedPrompt = this.pendingPrompt;
          this.pendingPrompt = null;
          this.viewing = this.keyFor(meta);
          if (queuedPrompt) {
            void this.session.prompt(queuedPrompt);
          }
          this.switching.close();
        }
        if (this.switching.isOpen) {
          this.switching.refresh();
        }
        this.renderChrome();
        break;
      }
      case "history": {
        const key = this.keyById(msg.session);
        if (key) {
          const old = this.views.get(key);
          this.views.set(key, {
            ...newView(),
            items: itemsFromMessages(msg.messages, this.tui, this.metaForPath(key)?.cwd ?? ""),
            // keep live activity if events raced ahead of the history reply
            activity: old?.activity,
            queue: old?.queue ?? [],
          });
          if (key === this.viewing) {
            this.rebuildChat();
          }
        }
        break;
      }
      case "event": {
        const key = this.keyById(msg.session);
        if (!key) {
          break;
        }
        const view = this.viewFor(key);
        this.applyEvent(key, view, msg.event);
        break;
      }
      case "ui_request": {
        const key = this.keyById(msg.session);
        if (!key) {
          break;
        }
        const view = this.viewFor(key);
        const request = msg.request as unknown as DialogRequest;
        if (request && DIALOG_METHODS.has(request.method)) {
          if (request.method === "input" || request.method === "editor") {
            // No free-form dialog UI yet; deny is the safe default.
            this.send({
              type: "ui_response",
              session: msg.session,
              response: { type: "extension_ui_response", id: request.id, cancelled: true },
            });
          } else {
            view.dialog = request;
          }
        } else if (request && request.method === "notify") {
          this.notify(String(request.message ?? "notification"));
        }
        if (key === this.viewing) {
          this.renderChrome();
        }
        break;
      }
      case "exited": {
        const meta = this.sessions.get(msg.session);
        if (meta && this.keyFor(meta) === this.viewing) {
          this.notify("child exited");
        }
        break;
      }
      case "response": {
        const pending = this.responses.get(msg.id);
        if (pending) {
          this.responses.delete(msg.id);
          if (msg.ok) {
            pending.resolve(msg.data);
          } else {
            pending.reject(new Error(msg.error ?? "daemon command failed"));
          }
        }
        break;
      }
    }
  }

  keyById(sessionId: number): string | null {
    const meta = this.sessions.get(sessionId);
    return meta ? this.keyFor(meta) : null;
  }

  keyFor(meta: SessionMeta): string {
    return sessionKey(meta);
  }

  metaForPath(key: string): SessionMeta | undefined {
    return [...this.sessions.values()].find((m) => this.keyFor(m) === key);
  }

  viewFor(key: string): SessionView {
    let view = this.views.get(key);
    if (!view) {
      view = newView();
      this.views.set(key, view);
    }
    return view;
  }

  async loadLocal(): Promise<void> {
    try {
      const infos = await SessionManager.listAll();
      this.local.clear();
      for (const info of infos) {
        this.local.set(info.path, {
          path: info.path,
          id: info.id,
          name: info.name,
          cwd: info.cwd,
          firstMessage: info.firstMessage ?? "",
          lastActivity: lastLine(info.allMessagesText ?? ""),
          modified: info.modified instanceof Date ? info.modified.getTime() : Date.parse(String(info.modified)) || 0,
        });
      }
    } catch (err) {
      console.error(`listAll failed: ${err}`);
    }
  }

  // ---------------- switcher ----------------


  // ---------------- key + submit routing ----------------

  /** Editor key hook: dialog answers first, then the active view's keys. */
  keys(data: string): boolean {
    if (isKeyRelease(data)) {
      return true;
    }
    const view = this.viewing ? this.views.get(this.viewing) : undefined;
    if (view?.dialog && this.session.dialogKeys(view, data)) {
      return true;
    }
    if (this.switching.isOpen) {
      return this.switching.keys(data);
    }
    if (this.rewindPicker.isOpen) {
      return this.session.pickerKeys(data);
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      this.toggleTools();
      return true;
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.toggleThinking();
      return true;
    }
    return this.session.keys(data);
  }

  submit(text: string): void {
    if (process.env.RONPI_KEYS) {
      try {
        fs.appendFileSync(process.env.RONPI_KEYS, `SUBMIT ${JSON.stringify(text)} open=${this.switching.isOpen}\n`);
      } catch {
        // debug only
      }
    }
    const command = text.trim();
    if (command.length > 1 && command.startsWith("/")) {
      recordCommand(HISTORY_FILE, command);
      this.editor.addToHistory(command);
    }
    if (this.switching.isOpen) {
      this.switching.submit(text.trim());
    } else {
      this.session.submit(text);
    }
  }

  applyEvent(key: string, view: SessionView, ev: Record<string, unknown>): void {
    const effects = applyEvent(view, ev, {
      tui: this.tui,
      cwd: this.metaForPath(key)?.cwd ?? this.local.get(key)?.cwd ?? process.cwd(),
      addItem: (item) => this.addItem(view, key, item),
    });
    if (effects.summary) {
      this.summaries.set(key, effects.summary);
    }
    const info = this.local.get(key);
    if (effects.messageEnded && info) {
      info.modified = Date.now();
    }
    if (key === this.viewing) {
      this.syncActivity();
      this.tui.requestRender();
    }
  }

  /**
   * Point the activity strip at the viewed session and run the animation
   * timer only while there is something to animate (no idle redraws).
   */
  syncActivity(opened = false): void {
    const view = this.viewing ? this.views.get(this.viewing) : undefined;
    if (opened && view && !view.activity && this.viewing && this.metaForPath(this.viewing)?.streaming) {
      // opened mid-run: the start event predates us. Only on open - the
      // daemon's streaming flag lags behind events and would resurrect a
      // spinner after agent_settled.
      view.activity = { label: "working", since: Date.now() };
    }
    this.activityLine.state = view ?? { queue: [] };
    const animate = Boolean(view?.activity) && !this.switching.isOpen;
    if (animate && !this.activityTimer) {
      this.activityTimer = setInterval(() => this.tui.requestRender(), 100);
    } else if (!animate && this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = undefined;
    }
  }

  /** Mount new items immediately on the viewed session; rebuildChat() mounts the rest. */
  addItem(view: SessionView, key: string, item: Item): void {
    this.applyDisplay(item);
    view.items.push(item);
    if (key === this.viewing) {
      this.chatRoot.addChild(item.component);
    }
  }

  /** Apply the global display toggles (tools expanded, thinking hidden) to one item. */
  private applyDisplay(item: Item): void {
    if (item.kind === "tools") {
      item.component.expanded = this.toolsExpanded;
    } else if (item.kind === "assistant") {
      item.component.setHideThinkingBlock(this.thinkingHidden);
    }
  }

  /** Re-apply the display toggles everywhere without moving the scroll position. */
  private redisplay(): void {
    for (const view of this.views.values()) {
      for (const item of view.items) {
        this.applyDisplay(item);
      }
    }
    this.chatRoot.invalidate();
    this.tui.requestRender(true);
  }

  /** Show/hide thinking blocks (ctrl-t); applies to all sessions. */
  toggleThinking(): void {
    this.thinkingHidden = !this.thinkingHidden;
    this.redisplay();
  }

  /** Expand/collapse every tool run (ctrl-o); applies to all sessions. */
  toggleTools(): void {
    this.toolsExpanded = !this.toolsExpanded;
    this.redisplay();
  }

  /**
   * Up-arrow history for what is on screen: the viewed session's own prompts
   * (read from its file, so it survives restarts) merged with the shared
   * command log; in the switcher, commands only. `force` re-reads even when
   * the context has not changed (after a rewind).
   */
  syncHistory(force = false): void {
    const token = this.switching.isOpen ? SWITCHER_HISTORY : this.viewing;
    if (!force && token === this.historyFor) {
      return;
    }
    let prompts: Array<{ ts: number; text: string }> = [];
    const key = this.viewing;
    if (token !== SWITCHER_HISTORY && key && fs.existsSync(key)) {
      try {
        prompts = rewindTargets(key);
      } catch {
        // unreadable file: commands only
      }
    }
    this.editor.setHistory(mergeHistory(prompts, loadCommands(HISTORY_FILE)));
    this.historyFor = token;
  }

  rebuildChat(): void {
    this.syncHistory();
    this.chatRoot.clear();
    const view = this.viewing ? this.views.get(this.viewing) : undefined;
    if (view) {
      for (const item of view.items) {
        this.applyDisplay(item);
        this.chatRoot.addChild(item.component);
      }
    }
    this.scroll.scrollToEnd();
    this.syncActivity(true);
    this.tui.requestRender(true);
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
    this.syncActivity();
    const width = this.tui.terminal.columns || process.stdout.columns || 80;
    const key = this.viewing;
    const stats = fleetStats(this.sessions.values());
    this.switcher.counts = { running: stats.running, waiting: stats.waiting };
    this.switcher.budget = { cost: stats.cost, tokens: stats.tokens };
    this.switcher.height = this.tui.terminal.rows || 24;
    const status = buildStatusLine({
      switcherOpen: this.switching.isOpen,
      selectedName: this.switcher.current()?.name,
      viewing: key,
      meta: key ? this.metaForPath(key) : undefined,
      info: key ? this.local.get(key) : undefined,
      stats,
      flash: this.flash,
      dialog: key ? this.views.get(key)?.dialog : undefined,
    });
    this.statusLine.setText(truncateToWidth(status, width));
    this.tui.requestRender();
  }
}

function main(): void {
  if (process.argv[2] === "kill-server") {
    void killServer();
    return;
  }
  try {
    assertTruecolor();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
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
