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
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import { appendFileSync } from "node:fs";
import * as path from "node:path";
import {
  Container,
  Editor,
  type EditorTheme,
  isKeyRelease,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  truncateToWidth,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import {
  AssistantMessageComponent,
  SessionManager,
  ToolExecutionComponent,
  UserMessageComponent,
  getMarkdownTheme,
  getSelectListTheme,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { loadGroups, resolveGroup, saveGroups, type GroupsFile } from "./groups.ts";
import { Switcher, type SessionState, type SwitcherSession } from "./switcher.ts";
import { LineSplitter, encodeLine, type ClientCommand, type DaemonMessage, type SessionMeta } from "./shared.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { accent as themeAccent, attention, dim as themeDim } from "./theme.ts";

const SOCK = process.env.RONPI_SOCK ?? `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/ronpi.sock`;
const PID_FILE = `${SOCK}.pid`;
const DAEMON_FILE = path.join(import.meta.dirname, "daemon.ts");
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when something is listening on the socket. */
function socketAlive(timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(SOCK);
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

/** Start the daemon detached, using this process's node (same v26 binary). */
function spawnDaemon(): void {
  const child = spawn(process.execPath, [DAEMON_FILE], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function waitForDaemon(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socketAlive()) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`daemon did not come up within ${Math.round(timeoutMs / 1000)}s (check ${SOCK} and the daemon log)`);
}

/** controller.ts kill-server: SIGTERM the daemon (orderly child shutdown). */
async function killServer(): Promise<void> {
  let pid: number | undefined;
  try {
    pid = Number.parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {
    // no pidfile below
  }
  if (!pid || Number.isNaN(pid)) {
    process.stderr.write(`no ronpid pidfile at ${PID_FILE} - daemon not running\n`);
    process.exit(1);
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!cmdline.includes("daemon.ts")) {
      process.stderr.write(`pid ${pid} is not ronpid (stale pidfile); refusing\n`);
      process.exit(1);
    }
  } catch {
    process.stderr.write(`daemon process ${pid} is gone (stale pidfile); cleaning up\n`);
    fs.rmSync(PID_FILE, { force: true });
    process.exit(1);
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      process.stdout.write(`ronpid (${pid}) stopped\n`);
      return;
    }
    await sleep(250);
  }
  process.kill(pid, "SIGKILL");
  process.stdout.write(`ronpid (${pid}) did not exit in 10s; sent SIGKILL\n`);
}

// The pi theme instance isn't exported from the package index, so chrome
// colors are plain ANSI; real theming (solarized) comes later.
const dim = themeDim;
const accent = themeAccent;

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

interface DialogRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
}

interface SessionView {
  items: Item[];
  tools: Map<string, ToolItem>;
  dialog?: DialogRequest;
}

interface LocalSession {
  path: string;
  id: string;
  name?: string;
  cwd: string;
  firstMessage: string;
  lastActivity: string;
  model?: string;
  modified: number;
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

// Left-arrow that carries no modifiers beyond caps/numlock lock bits: legacy
// \x1b[D / \x1bOD, kitty/csi-u \x1b[1;<mods>D or \x1b[1;<mods>:<event>D.
function isPlainLeft(data: string): boolean {
  if (data === "\x1b[D" || data === "\x1bOD") {
    return true;
  }
  const m = /^\x1b\[1;(\d+)(?::(\d+))?D$/.exec(data);
  if (!m) {
    return false;
  }
  if (m[2] === "3") {
    return false; // key release
  }
  const mods = Number.parseInt(m[1], 10) - 1;
  return (mods & ~(64 | 128)) === 0;
}

// The Editor's history navigation has no default bindings - bind up/down.
// navigateHistory falls through to cursor movement unless the editor is
// empty or the cursor is on its first/last visual line.
setKeybindings(
  new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.editor.historyPrevious": ["up"],
    "tui.editor.historyNext": ["down"],
  }),
);

class InputEditor extends Editor {
  onKey?: (data: string) => boolean;
  debugLog?: string;

  handleInput(data: string): void {
    if (this.debugLog) {
      try {
        appendFileSync(this.debugLog, `${JSON.stringify(data)}\n`);
      } catch {
        // debug only
      }
    }
    if (this.onKey && this.onKey(data)) {
      return;
    }
    super.handleInput(data);
  }
}

class Controller {
  tui: TuiAltScreen;
  chatRoot = new Container();
  chatLayout: VStack;
  switcherLayout: VStack;
  scroll: ScrollView;
  statusLine = new Text("", 0, 0);
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

  groups: GroupsFile = { groups: [], assignments: {} };
  switcherOpen = false;

  private lastRefused: string | null = null;
  /** Armed: prompting a recently-modified external session (fork warning). */
  private armedFork: string | null = null;
  private armedDelete: string | null = null;
  private pendingEnterId: number | null = null;
  /** Text to send once pendingEnterId resolves (adopt-then-prompt flow). */
  private pendingPrompt: string | null = null;
  private sessionsLoaded = false;
  private reqSeq = 0;
  private responses = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private flash = "";
  private flashTimer?: ReturnType<typeof setTimeout>;
  /** Session key order captured when the switcher opened; frozen while open. */
  private switchOrder: string[] | null = null;
  private listTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.tui = new TuiAltScreen(new ProcessTerminal(), true);
    this.scroll = new ScrollView(this.chatRoot, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
    this.editor = new InputEditor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.debugLog = process.env.RONPI_KEYS ?? "";
    this.editor.onSubmit = (text) => this.submit(text);
    this.editor.onKey = (data) => this.sessionKeys(data);
    const dock = new VStack([
      { component: this.editor, shrink: 0, minSize: 3 },
      { component: this.statusLine, shrink: 0, minSize: 1 },
    ]);
    // Two roots over one shared dock: the chat view, and the switcher view
    // (full-screen minus the dock, so the input box is never covered).
    this.chatLayout = new VStack([
      { component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
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
    this.switcher.onSelect = (s) => void this.enterSession(s);
    this.switcher.onMoved = () => this.tui.requestRender();
    this.switcher.onShiftSession = (delta, s) => void this.moveSession(delta, s);
    this.switcher.onShiftGroup = (delta, title) => void this.moveGroup(delta, title);
    this.switcher.onClose = () => this.closeSwitcher();
    this.switcher.onNew = () => void this.newSession();
    this.switcher.onKill = (s) => void this.killSession(s);
    this.switcher.onRename = (s) => {
      this.switcher.command = "/rename ";
      this.switcher.hint = `rename: ${s.name} - type the new name and press enter`;
    };
    this.switcher.onGroup = (s) => {
      this.switcher.command = "/group ";
      this.switcher.hint = `group: ${s.name} - type a group name and press enter`;
    };
    this.switcher.onCommand = (cmd, target) => void this.runCommand(cmd, target);
  }

  async run(): Promise<void> {
    try {
      await this.connect();
    } catch {
      // No daemon. Re-check briefly (another controller may be mid-start),
      // then start one in the background and wait for the socket.
      if (!(await socketAlive())) {
        await sleep(400);
      }
      if (!(await socketAlive())) {
        spawnDaemon();
        await waitForDaemon(20_000);
      }
      await this.connect();
    }
    await this.loadLocal();
    this.renderChrome();
    try {
      this.tui.start();
      this.openSwitcher();
      this.listTimer = setInterval(() => {
        void this.loadLocal().then(() => {
          if (this.switcherOpen) {
            this.refreshSwitcher();
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
  request(cmd: Omit<ClientCommand, "id"> & { id?: string }): Promise<unknown> {
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
            void this.prompt(queuedPrompt);
          }
          this.viewing = this.keyFor(meta);
          this.closeSwitcher();
        }
        if (this.switcherOpen) {
          this.refreshSwitcher();
        }
        this.renderChrome();
        break;
      }
      case "history": {
        const key = this.keyById(msg.session);
        if (key) {
          this.views.set(key, { items: itemsFromMessages(msg.messages, this.tui, this.metaForPath(key)?.cwd ?? ""), tools: new Map() });
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
        const request = msg.request as DialogRequest;
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
    return meta.sessionFile ?? `daemon:${meta.id}`;
  }

  metaForPath(key: string): SessionMeta | undefined {
    return [...this.sessions.values()].find((m) => this.keyFor(m) === key);
  }

  viewFor(key: string): SessionView {
    let view = this.views.get(key);
    if (!view) {
      view = { items: [], tools: new Map() };
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

  openSwitcher(): void {
    // Release input on the session we were driving; re-enter re-attaches.
    if (this.viewing) {
      const meta = this.metaForPath(this.viewing);
      if (meta?.attachedToYou) {
        this.send({ type: "detach", session: meta.id });
      }
    }
    this.groups = loadGroups();
    this.switchOrder = null;
    this.armedDelete = null;
    this.lastRefused = null;
    this.armedFork = null;
    // Land on the session we were just in, else the first session.
    this.switcher.selectedKey = this.viewing;
    this.refreshSwitcher();
    this.switcher.height = this.tui.terminal.rows || 24;
    this.switcher.hint = "type / for commands - enter open - ctrl-n new - ctrl-x kill - ctrl-r rename - ctrl-g group";
    this.switcher.heightProvider = () => Math.max(6, (this.tui.terminal.rows || 24) - 4);
    this.switcherOpen = true;
    this.tui.setLayoutRoot(this.switcherLayout);
    this.editor.setText("");
    this.renderChrome();
    this.tui.requestRender(true);
  }

  closeSwitcher(): void {
    this.switcherOpen = false;
    this.tui.setLayoutRoot(this.chatLayout);
    this.rebuildChat();
    this.renderChrome();
    this.tui.requestRender(true);
  }

  refreshSwitcher(): void {
    this.groups = loadGroups();
    const list: SwitcherSession[] = [];
    const paths = new Set<string>([...this.local.keys()]);
    for (const meta of this.sessions.values()) {
      paths.add(this.keyFor(meta));
    }
    for (const key of paths) {
      const meta = this.metaForPath(key);
      const info = this.local.get(key);
      if (meta && meta.id < 0 && !info) {
        // external pi that has not written its session file yet
        continue;
      }
      const cwd = meta?.cwd ?? info?.cwd ?? (key.startsWith("daemon:") ? key : path.dirname(key));
      // Unnamed sessions show their first message as the name; the project
      // (cwd basename) moves to the description column.
      const explicitName = meta?.sessionName ?? info?.name;
      const first = info?.firstMessage ? oneLineFlat(info.firstMessage, 40) : undefined;
      const base = path.basename(cwd);
      const name = explicitName ?? first ?? "<unnamed>";
      let state: SessionState = "inactive";
      if (meta?.active) {
        state = meta.streaming ? "streaming" : meta.dead ? "dead" : "idle";
      }
      const sessionId = meta?.sessionId ?? info?.id;
      const group = sessionId ? (this.groups.assignments[sessionId] ?? undefined) : undefined;
      let note: string | undefined;
      if (meta?.pendingDialog) {
        note = "waiting on permission";
      } else if (meta?.externallyLive) {
        note = "live in pi - /adopt to fork";
      } else if (meta?.attachedElsewhere) {
        note = "view-only";
      } else if (state === "dead") {
        note = "crashed - prompt respawns";
      }
      const longModel = meta?.model;
    const modified = info?.modified ?? 0;
    list.push({
        key,
        name,
        group,
        state,
        muted: !!meta?.externallyLive,
        daemonId: meta?.id,
        sessionId,
        cwd,
        note,
        age: fmtAge(modified > 0 ? Date.now() - modified : 0),
        model: longModel ? longModel.split("/").pop() : info?.model,
        description:
          note ??
          this.summaries.get(key) ??
          info?.lastActivity ??
          (explicitName ? (first ?? base) : base),
      });
    }
    // Display order: the persisted manual order (groups.json `order`)
    // first, then sessions never manually placed, in the order captured
    // when the switcher opened (frozen, so background file activity
    // elsewhere never reshuffles the list under the cursor).
    if (this.switchOrder === null) {
      this.switchOrder = list.map((s) => s.key);
    }
    const manual = new Map((this.groups.order ?? []).map((k, i) => [k, i]));
    const opened = new Map(this.switchOrder.map((k, i) => [k, i]));
    list.sort((a, b) => {
      let ra = a.sessionId !== undefined ? manual.get(a.sessionId) : undefined;
      let rb = b.sessionId !== undefined ? manual.get(b.sessionId) : undefined;
      if (ra !== undefined || rb !== undefined) {
        ra = ra ?? Number.MAX_SAFE_INTEGER;
        rb = rb ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) {
          return ra - rb;
        }
      }
      const oa = opened.get(a.key) ?? Number.MAX_SAFE_INTEGER;
      const ob = opened.get(b.key) ?? Number.MAX_SAFE_INTEGER;
      return oa !== ob ? oa - ob : a.key.localeCompare(b.key);
    });
    if (process.env.RONPI_KEYS) {
      try {
        appendFileSync(process.env.RONPI_KEYS, `REFRESH_SWITCHER paths=${list.length} local=${this.local.size} daemon=${this.sessions.size}: ${list.map((x) => x.key.split("/").pop()).join(",")}\n`);
      } catch {
        // debug only
      }
    }
    this.switcher.sessions = list;
    this.switcher.groups = this.groups.groups;
    this.switcher.height = this.tui.terminal.rows || 24;
    this.switcher.refresh();
    this.tui.requestRender();
  }

  async enterSession(s: SwitcherSession): Promise<void> {
    if (s.daemonId !== undefined && (s.state === "streaming" || s.state === "idle")) {
      try {
        await this.request({ type: "attach", session: s.daemonId, force: this.lastRefused === s.key });
        this.lastRefused = null;
      } catch (err) {
        this.lastRefused = s.key;
        this.switcher.hint = `${err instanceof Error ? err.message : err} - enter again to take over`;
        this.tui.requestRender();
        return;
      }
    }
    this.viewing = s.key;
    if (!this.views.has(s.key)) {
      this.views.set(s.key, { items: this.parseSessionFile(s.key, this.tui, s.cwd), tools: new Map() });
    }
    this.closeSwitcher();
    this.rebuildChat();
  }

  parseSessionFile(file: string, tui: TuiAltScreen, cwd: string): Item[] {
    try {
      const content = fs.readFileSync(file, "utf8");
      const messages: unknown[] = [];
      for (const line of content.split("\n")) {
        if (!line) {
          continue;
        }
        try {
          const entry = JSON.parse(line) as { type?: string; message?: unknown };
          if (entry.type === "message" && entry.message) {
            messages.push(entry.message);
          }
        } catch {
          // tolerate a torn trailing line
        }
      }
      return itemsFromMessages(messages, tui, cwd);
    } catch {
      return [{ kind: "other", component: new Text(dim("(session file unreadable)"), 1, 0) }];
    }
  }

  async newSession(): Promise<void> {
    try {
      const data = (await this.request({ type: "spawn", cwd: process.cwd() })) as { sessionId?: number };
      if (typeof data?.sessionId === "number") {
        const meta = this.sessions.get(data.sessionId);
        if (meta) {
          this.viewing = this.keyFor(meta);
          this.closeSwitcher();
        } else {
          this.pendingEnterId = data.sessionId;
          this.switcher.hint = "starting session...";
        }
      }
    } catch (err) {
      this.switcher.hint = `spawn failed: ${err instanceof Error ? err.message : err}`;
      this.tui.requestRender();
    }
  }

  async killSession(s: SwitcherSession): Promise<void> {
    try {
      if (s.state === "streaming" || s.state === "idle") {
        if (s.daemonId === undefined) {
          throw new Error("no daemon session");
        }
        await this.request({ type: "deactivate", session: s.daemonId });
        this.switcher.hint = `deactivated ${s.name} (file kept; respawns on next prompt)`;
      } else {
        // inactive or dead: delete = trash, with a press-twice confirm
        if (this.armedDelete !== s.key) {
          this.armedDelete = s.key;
          this.switcher.hint = `${s.name}: press ctrl-x again to move to trash`;
          this.tui.requestRender();
          return;
        }
        this.armedDelete = null;
        // keep the cursor where it is: select the next entry (or the
        // previous one at the end) before the row disappears
        this.switcher.selectNextAfter(s.key);
        await this.request({ type: "delete", path: s.key.startsWith("daemon:") ? undefined : s.key, session: s.daemonId });
        this.views.delete(s.key);
        await this.loadLocal();
        this.switcher.hint = `${s.name} moved to trash (/restore not built yet)`;
      }
      this.refreshSwitcher();
    } catch (err) {
      this.switcher.hint = `kill failed: ${err instanceof Error ? err.message : err}`;
    }
    this.tui.requestRender();
  }

  /** shift+up/down on a session row: relocate within/between sections. */
  async moveSession(delta: number, s: SwitcherSession): Promise<void> {
    if (!s.sessionId) {
      this.switcher.hint = "session has no id yet - prompt it once, then move it";
      this.tui.requestRender();
      return;
    }
    // Section structure INCLUDING empty groups: [ungrouped, ...groups].
    // Moves are section-relative, so an empty group is a valid target
    // (the moved session becomes its only member).
    const sections: Array<{ group: string | null; uuids: string[] }> = [{ group: null, uuids: [] }];
    for (const g of this.groups.groups) {
      sections.push({ group: g, uuids: [] });
    }
    const sectionIndex = (group: string | null) => (group === null ? 0 : 1 + this.groups.groups.indexOf(group));
    for (const x of this.switcher.sessions) {
      if (x.sessionId !== undefined) {
        sections[sectionIndex(x.group ?? null)].uuids.push(x.sessionId);
      }
    }
    const secIdx = sectionIndex(s.group ?? null);
    const pos = sections[secIdx].uuids.indexOf(s.sessionId as string);
    if (pos === -1) {
      return;
    }
    const uuid = s.sessionId as string;
    if (delta > 0) {
      if (pos < sections[secIdx].uuids.length - 1) {
        // swap down within the section
        const swapped = sections[secIdx].uuids[pos + 1];
        sections[secIdx].uuids[pos + 1] = uuid;
        sections[secIdx].uuids[pos] = swapped;
      } else if (sections[secIdx + 1]) {
        // last of section -> first of the next section
        const next = sections[secIdx + 1];
        sections[secIdx].uuids.splice(pos, 1);
        next.uuids.unshift(uuid);
        this.groups.assignments[uuid] = next.group;
      } else {
        this.switcher.hint = "already at the bottom";
        this.tui.requestRender();
        return;
      }
    } else {
      if (pos > 0) {
        // swap up within the section
        const swapped = sections[secIdx].uuids[pos - 1];
        sections[secIdx].uuids[pos - 1] = uuid;
        sections[secIdx].uuids[pos] = swapped;
      } else if (sections[secIdx - 1]) {
        // first of section -> last of the previous section
        const prev = sections[secIdx - 1];
        sections[secIdx].uuids.splice(pos, 1);
        prev.uuids.push(uuid);
        this.groups.assignments[uuid] = prev.group;
      } else {
        this.switcher.hint = "already at the top";
        this.tui.requestRender();
        return;
      }
    }
    this.groups.order = sections.flatMap((sec) => sec.uuids);
    saveGroups(this.groups);
    this.refreshSwitcher();
    this.tui.requestRender();
  }

  /** shift+up/down on a group header: swap with the neighboring group. */
  async moveGroup(delta: number, title: string): Promise<void> {
    const gs = this.groups.groups;
    const i = gs.indexOf(title);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= gs.length) {
      this.switcher.hint = delta < 0 ? "already the first group" : "already the last group";
      this.tui.requestRender();
      return;
    }
    gs[i] = gs[j];
    gs[j] = title;
    saveGroups(this.groups);
    this.refreshSwitcher();
    this.tui.requestRender();
  }

  /** ctrl-x on a group header: delete it (only when it has no sessions). */
  async deleteGroupIfEmpty(title: string): Promise<void> {
    if (title === "(ungrouped)") {
      this.switcher.hint = "(ungrouped) can't be deleted";
      this.tui.requestRender();
      return;
    }
    const count = this.switcher.sessions.filter((x) => x.group === title).length;
    if (count > 0) {
      this.switcher.hint = `${title} has ${count} session${count === 1 ? "" : "s"} - move them out first`;
      this.tui.requestRender();
      return;
    }
    const i = this.groups.groups.indexOf(title);
    if (i !== -1) {
      this.groups.groups.splice(i, 1);
      // Purge stale assignments (e.g. from trashed sessions) - saveGroups
      // resurrects any group an assignment still references.
      for (const [id, g] of Object.entries(this.groups.assignments)) {
        if (g === title) {
          this.groups.assignments[id] = null;
        }
      }
      saveGroups(this.groups);
    }
    this.switcher.hint = `group ${title} deleted`;
    this.refreshSwitcher();
    this.tui.requestRender();
  }

  async runCommand(cmd: string, target: SwitcherSession | undefined): Promise<void> {
    const [name, ...rest] = cmd.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (name.toLowerCase()) {
      case "new":
        await this.newSession();
        break;
      case "kill":
        if (!target) {
          this.switcher.hint = "kill: highlight a session first";
        } else {
          await this.killSession(target);
        }
        break;
      case "rename": {
        if (!target) {
          this.switcher.hint = "rename: highlight a session first";
        } else if (!arg) {
          this.editor.setText("/rename ");
          this.switcher.hint = `rename: ${target.name} - type the new name and press enter`;
        } else {
          try {
            await this.request({
              type: "rename",
              session: target.daemonId,
              path: target.daemonId === undefined ? target.key : undefined,
              name: arg,
            });
            await this.loadLocal();
            this.refreshSwitcher();
            this.switcher.hint = `renamed to ${arg}`;
          } catch (err) {
            this.switcher.hint = `rename failed: ${err instanceof Error ? err.message : err}`;
          }
        }
        break;
      }
      case "group": {
        if (!target) {
          this.switcher.hint = "group: highlight a session first";
        } else if (!arg) {
          this.editor.setText("/group ");
          this.switcher.hint = `group: ${target.name} - type a group name and press enter`;
        } else if (!target.sessionId) {
          this.switcher.hint = "group: session has no id yet";
        } else {
          try {
            const group = resolveGroup(this.groups, arg);
            this.groups.assignments[target.sessionId] = group;
            saveGroups(this.groups);
            this.refreshSwitcher();
            this.switcher.hint = `${target.name} -> ${group}`;
          } catch (err) {
            this.switcher.hint = `group failed: ${err instanceof Error ? err.message : err}`;
          }
        }
        break;
      }
      case "exit":
      case "quit":
        this.dispose();
        break;
      case "help":
        this.switcher.hint = "/new /kill /rename <name> /group <name> /adopt /kill-daemon /exit /help";
        break;
      case "restore":
        this.switcher.hint = "/restore is not built yet (trash keeps everything)";
        break;
      case "adopt": {
        const t = target ?? this.switcher.current();
        if (!t) {
          this.switcher.hint = "adopt: highlight a session first";
        } else if (!t.key.startsWith("/")) {
          this.switcher.hint = "adopt: not a file-backed session";
        } else {
          try {
            const data = (await this.request({ type: "adopt", path: t.key, cwd: t.cwd ?? process.cwd() })) as {
              sessionId?: number;
            };
            if (typeof data?.sessionId === "number") {
              const meta = this.sessions.get(data.sessionId);
              if (meta) {
                this.viewing = this.keyFor(meta);
                this.closeSwitcher();
              } else {
                this.pendingEnterId = data.sessionId;
                this.switcher.hint = "adopting...";
              }
            }
          } catch (err) {
            this.switcher.hint = `adopt failed: ${err instanceof Error ? err.message : err}`;
          }
        }
        break;
      }
      case "kill-daemon":
        this.send({ type: "shutdown" });
        this.switcher.hint = "daemon shutting down (children stop too)";
        break;
      default:
        this.switcher.hint = `unknown command: /${name} (/help)`;
    }
    this.tui.requestRender();
  }

  // ---------------- session view ----------------

  sessionKeys(data: string): boolean {
    if (isKeyRelease(data)) {
      return true;
    }
    const view = this.viewing ? this.views.get(this.viewing) : undefined;
    if (view?.dialog && this.dialogKeys(view, data)) {
      return true;
    }
    if (this.switcherOpen) {
      return this.switcherKeys(data);
    }
    if (matchesKey(data, Key.escape)) {
      // esc = interrupt the running agent (pi muscle memory); also
      // cancels an armed fork-confirm
      this.armedFork = null;
      const meta = this.viewing ? this.metaForPath(this.viewing) : undefined;
      if (meta?.id !== undefined && meta.attachedToYou && meta.streaming) {
        this.send({ type: "abort", session: meta.id });
        this.notify("aborted");
      }
      return true;
    }
    if (isPlainLeft(data) && this.editor.getText().trim().length === 0) {
      this.openSwitcher();
      return true;
    }
    return false;
  }

  /** While the switcher is open the chat box is the switcher's input. */
  switcherKeys(data: string): boolean {
    const editorEmpty = this.editor.getText().trim().length === 0;
    if (matchesKey(data, Key.up) && editorEmpty) {
      this.switcher.move(-1);
      this.tui.requestRender();
      return true;
    }
    if (matchesKey(data, Key.down) && editorEmpty) {
      this.switcher.move(1);
      this.tui.requestRender();
      return true;
    }
    if (matchesKey(data, "shift+up")) {
      this.switcher.shiftMove(-1);
      return true;
    }
    if (matchesKey(data, "shift+down")) {
      this.switcher.shiftMove(1);
      return true;
    }
    if (matchesKey(data, Key.escape)) {
      // In the switcher, esc cancels the action in progress (a typed
      // command) - it never navigates. left is the "go back" key.
      if (this.editor.getText().trim().length > 0) {
        this.editor.setText("");
        this.switcher.hint = "";
      }
      return true;
    }
// left is a no-op in the switcher (furthest back level)

    if (matchesKey(data, Key.right) && editorEmpty) {
      const target = this.switcher.currentOrGroupFirst();
      if (target) {
        void this.enterSession(target);
      }
      return true;
    }
    if (matchesKey(data, Key.ctrl("n"))) {
      void this.newSession();
      return true;
    }
    if (matchesKey(data, Key.ctrl("x"))) {
      if (this.switcher.currentIsHeader()) {
        void this.deleteGroupIfEmpty(this.switcher.currentHeaderTitle());
        return true;
      }
      const target = this.switcher.current();
      if (target) {
        void this.killSession(target);
      }
      return true;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      const target = this.switcher.current();
      if (this.switcher.currentIsHeader() || !target) {
        this.switcher.hint = "rename works on sessions, not group headers";
      } else {
        this.editor.setText(`/rename ${target.name}`);
        this.switcher.hint = "rename: edit the name and press enter";
      }
      return true;
    }
    if (matchesKey(data, Key.ctrl("g"))) {
      const target = this.switcher.current();
      if (this.switcher.currentIsHeader() || !target) {
        this.switcher.hint = "group works on sessions, not group headers";
      } else {
        this.editor.setText(`/group ${target.group ?? ""}`);
        this.switcher.hint = `group: ${target.name} - edit or type a group name and press enter`;
      }
      return true;
    }
    return false;
  }

  /** Returns true when the key was consumed as a dialog answer. */
  dialogKeys(view: SessionView, data: string): boolean {
    const dialog = view.dialog!;
    if (!this.viewing) {
      return false;
    }
    const meta = this.metaForPath(this.viewing);
    if (!meta?.attachedToYou) {
      return false;
    }
    const answer = (fields: Record<string, unknown>) => {
      this.send({
        type: "ui_response",
        session: meta.id,
        response: { type: "extension_ui_response", id: dialog.id, ...fields },
      });
      view.dialog = undefined;
      this.renderChrome();
    };
    if (dialog.method === "confirm") {
      if (data === "y") {
        answer({ confirmed: true });
        return true;
      }
      if (data === "n") {
        answer({ confirmed: false });
        return true;
      }
      return false;
    }
    if (dialog.method === "select") {
      const options = dialog.options ?? [];
      const idx = Number.parseInt(data, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
        answer({ value: options[idx - 1] });
        return true;
      }
      if (data === "\x1b") {
        answer({ cancelled: true });
        return true;
      }
    }
    return false;
  }

  submit(text: string): void {
    if (process.env.RONPI_KEYS) {
      try {
        appendFileSync(process.env.RONPI_KEYS, `SUBMIT ${JSON.stringify(text)} open=${this.switcherOpen}\n`);
      } catch {
        // debug only
      }
    }
    const trimmed = text.trim();
    if (this.switcherOpen) {
      // The chat box doubles as the switcher's command line.
      this.editor.setText("");
      if (trimmed.startsWith("/")) {
        void this.runCommand(trimmed, this.switcher.current());
        return;
      }
      // enter on the box opens the highlighted session (or the first
      // session under a highlighted group header)
      const target = this.switcher.currentOrGroupFirst();
      if (target) {
        void this.enterSession(target);
      }
      return;
    }
    if (trimmed.length === 0) {
      return;
    }
    if (trimmed === "/exit") {
      this.dispose();
      return;
    }
    if (trimmed === "/quit") {
      this.openSwitcher();
      this.editor.setText("");
      return;
    }
    if (trimmed === "/abort") {
      const meta = this.viewing ? this.metaForPath(this.viewing) : undefined;
      if (meta?.id !== undefined && meta.attachedToYou) {
        this.send({ type: "abort", session: meta.id });
        this.notify("abort sent");
      } else {
        this.notify("nothing to abort here");
      }
      this.editor.setText("");
      return;
    }
    void this.prompt(trimmed);
  }

  /** /adopt the given session file, then deliver `text` to the fork once
   * entered. The prompt replays from pendingPrompt if the session metadata
   * has not arrived yet. */
  private async adoptAndPrompt(key: string, cwd: string, text: string): Promise<void> {
    try {
      const data = (await this.request({ type: "adopt", path: key, cwd })) as {
        sessionId?: number;
      };
      if (typeof data?.sessionId !== "number") {
        throw new Error("no session id");
      }
      const meta = this.sessions.get(data.sessionId);
      if (meta) {
        this.viewing = this.keyFor(meta);
        await this.prompt(text);
      } else {
        this.pendingEnterId = data.sessionId;
        this.pendingPrompt = text;
      }
    } catch (err) {
      this.notify(`fork failed: ${err instanceof Error ? err.message : err}`);
      this.editor.setText(text);
    }
  }

  async prompt(text: string): Promise<boolean> {
    const key = this.viewing;
    if (!key) {
      return false;
    }
    const meta = this.metaForPath(key);
    if (meta?.attachedElsewhere) {
      this.notify("view-only: this session is attached in another controller");
      return false;
    }
    if (meta?.externallyLive && meta.active) {
      // double-open: ronpi owns a live child AND a plain pi has the same
      // file open - forking cannot help, two writers would diverge
      this.notify("open in both ronpi and another pi - close one before prompting here");
      this.editor.setText(text);
      return false;
    }
    if (meta?.externallyLive) {
      if (this.armedFork !== key) {
        this.armedFork = key;
        this.notify(
          "live in another pi - continuing here FORKS the conversation (pi keeps its copy). enter again to fork and continue here, esc to cancel",
        );
        this.editor.setText(text);
        return false;
      }
      this.armedFork = null;
      const cwd = meta.cwd || path.dirname(key);
      void this.adoptAndPrompt(key, cwd, text);
      return true;
    }
    try {
      if (meta) {
        await this.request({ type: "prompt", session: meta.id, message: text });
      } else {
        const info = this.local.get(key);
        if (!key.startsWith("/") || !info) {
          this.notify("cannot start this session (no session file)");
          return false;
        }
        // The file may be open in an external (non-daemon) pi process -
        // undetectable directly, but a very recent mtime is a strong
        // signal. Prompting it forks the conversation (pi's tree
        // format keeps both branches), so confirm once.
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(key).mtimeMs;
        } catch {
          // stat failure: treat as old
        }
        const recent = Date.now() - mtimeMs < 60_000;
        if (recent && this.armedFork !== key) {
          this.armedFork = key;
          this.notify(
            `changed ${fmtAge(Date.now() - mtimeMs)} ago - may be open in another pi; enter again to FORK it and continue here, esc to cancel`,
          );
          this.editor.setText(text);
          return false;
        }
        this.armedFork = null;
        await this.request({
          type: "prompt",
          sessionFile: key,
          cwd: info.cwd || path.dirname(key),
          message: text,
        });
      }
      this.editor.addToHistory(text);
      this.editor.setText("");
      return true;
    } catch (err) {
      this.notify(`prompt failed: ${err instanceof Error ? err.message : err}`);
      this.editor.setText(text);
      return false;
    }
  }

  // ---------------- rendering ----------------

  applyEvent(key: string, view: SessionView, ev: Record<string, unknown>): void {
    const type = ev.type as string;
    switch (type) {
      case "message_start": {
        const m = ev.message as { role?: string; content?: unknown };
        if (m?.role === "user") {
          this.addItem(view, key, { kind: "user", component: new UserMessageComponent(userText(m), mdTheme, 1) });
        } else if (m?.role === "assistant") {
          const partial = m as AssistantItem["partial"];
          this.addItem(view, key, {
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
        const item = lastAssistant(view);
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
        if ((m?.role === "assistant" || m?.role === "user") && userText(m).trim()) {
          this.summaries.set(key, oneLineFlat(userText(m), 80));
        }
        if (m?.role === "assistant" || m?.role === "user") {
          const info = this.local.get(key);
          if (info) {
            info.modified = Date.now();
          }
        }
        if (m?.role === "assistant") {
          const item = lastAssistant(view);
          if (item) {
            item.partial = m as AssistantItem["partial"];
            item.component.updateContent(item.partial as never, false);
          } else {
            // attached mid-run: the completed message never streamed here
            this.addItem(view, key, {
              kind: "assistant",
              component: new AssistantMessageComponent(m as never, true, mdTheme, undefined, 1),
              partial: m as AssistantItem["partial"],
              text: new Map(),
              thinking: new Map(),
            });
          }
          if (m.stopReason === "error") {
            const errText = userText(m).trim() || "(provider error)";
            this.addItem(view, key, { kind: "other", component: new Text(attention(`error: ${errText}`), 1, 0) });
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
          this.metaForPath(key)?.cwd ?? this.local.get(key)?.cwd ?? process.cwd(),
        );
        component.markExecutionStarted();
        const item: ToolItem = { kind: "tool", component };
        this.addItem(view, key, item);
        view.tools.set(ev.toolCallId as string, item);
        break;
      }
      case "tool_execution_update": {
        const item = view.tools.get(ev.toolCallId as string);
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
        const item = view.tools.get(ev.toolCallId as string);
        if (item) {
          item.component.setArgsComplete();
          item.component.updateResult(ev.result as never, false);
        }
        break;
      }
    }
    if (key === this.viewing) {
      this.scroll.scrollToEnd();
      this.tui.requestRender();
    }
  }

  /** Mount new items immediately on the viewed session; rebuildChat() mounts the rest. */
  addItem(view: SessionView, key: string, item: Item): void {
    view.items.push(item);
    if (key === this.viewing) {
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
      const block = content[idx] as { type: string; text?: string; thinking?: string } | undefined;
      const finalText = delta.content as string | undefined;
      if (block && typeof finalText === "string") {
        if (block.type === "text") {
          block.text = finalText;
          item.text.set(idx, finalText);
        } else if (block.type === "thinking") {
          block.thinking = finalText;
          item.thinking.set(idx, finalText);
        }
      }
    }
    // toolcall_* deltas are skipped: tools render from tool_execution_* events
  }

  rebuildChat(): void {
    this.chatRoot.clear();
    const view = this.viewing ? this.views.get(this.viewing) : undefined;
    if (view) {
      for (const item of view.items) {
        this.chatRoot.addChild(item.component);
      }
    }
    this.scroll.scrollToEnd();
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
    const width = this.tui.terminal.columns || process.stdout.columns || 80;
    const key = this.viewing;
    const meta = key ? this.metaForPath(key) : undefined;
    const info = key ? this.local.get(key) : undefined;

    let running = 0;
    let waiting = 0;
    for (const m of this.sessions.values()) {
      if (m.streaming) {
        running++;
      }
      if (m.pendingDialog) {
        waiting++;
      }
    }
    this.switcher.counts = { running, waiting };
    this.switcher.height = this.tui.terminal.rows || 24;
    let totTokens = 0;
    let totCost = 0;
    for (const m of this.sessions.values()) {
      totTokens += m.tokens ?? 0;
      totCost += m.cost ?? 0;
    }
    this.switcher.budget = { cost: totCost, tokens: totTokens };

    let status: string;
    if (this.switcherOpen) {
      const sel = this.switcher.current();
      status = dim(
        sel
          ? `switcher - ${sel.name} - enter open, arrows navigate, / for commands`
          : "switcher - esc or left closes",
      );
    } else if (key) {
      const explicitName = meta?.sessionName ?? info?.name;
      const first = info?.firstMessage ? oneLineFlat(info.firstMessage, 40) : undefined;
      const name = explicitName ?? first ?? "<unnamed>";
      const state = meta
        ? !meta.active
          ? "inactive"
          : meta.streaming
            ? "working"
            : meta.dead
              ? "crashed"
              : "idle"
        : "inactive";
      const parts = [name];
      const shortModel = meta?.model?.split("/").pop();
      if (shortModel && shortModel !== "loading") {
        parts.push(shortModel);
      }
      parts.push(state);
      if ((meta?.tokens ?? 0) > 0) {
        parts.push(`${fmtTokens(meta.tokens as number)} tok`);
      }
      if ((meta?.cost ?? 0) > 0) {
        parts.push(`$${(meta.cost as number).toFixed(2)}`);
      }
      if (meta?.attachedElsewhere) {
        parts.push(attention("VIEW-ONLY"));
      }
      if (meta?.externallyLive) {
        parts.push(attention("LIVE-IN-PI"));
      }
      parts.push(dim(`${running} running, ${waiting} waiting`));
      parts.push(dim("left: switcher"));
      status = parts.join(dim(" | "));
    } else {
      status = dim(`${running} running, ${waiting} waiting | left: switcher`);
    }
    if (this.flash) {
      status = accent(this.flash);
    }
    if (this.viewing) {
      const view = this.views.get(this.viewing);
      if (view?.dialog) {
        const d = view.dialog;
        if (d.method === "confirm") {
          status = accent(`PERMISSION: ${d.title ?? "confirm"}${d.message ? ` - ${d.message}` : ""}  [y]es [n]o`);
        } else {
          const opts = (d.options ?? []).map((o, i) => `${i + 1}:${o}`).join("  ");
          status = accent(`PERMISSION: ${d.title ?? "select"}  ${opts}`);
        }
      }
    }
    this.statusLine.setText(truncateToWidth(status, width));
    this.tui.requestRender();
  }
}

function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h`;
  }
  return `${Math.floor(h / 24)}d`;
}

function fmtTokens(n: number): string {
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1)}k`;
  }
  return String(Math.round(n));
}

/** Cheap model probe: the model_change entry sits near the top of the file. */
function modelFromFile(path: string): string | undefined {
  try {
    const fd = fs.openSync(path, "r");
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    return /"modelId":"([^"]+)"/.exec(buf.toString("utf8", 0, n))?.[1];
  } catch {
    return undefined;
  }
}

/** Tail of a long text blob, for "last activity" columns. */
function lastLine(text: string, width = 90): string {
  const flat = oneLineFlat(text, Number.MAX_SAFE_INTEGER);
  return flat.length > width ? `...${flat.slice(-width)}` : flat;
}

function oneLineFlat(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}...` : flat;
}

function lastAssistant(view: SessionView): AssistantItem | undefined {
  for (let i = view.items.length - 1; i >= 0; i--) {
    const item = view.items[i];
    if (item.kind === "assistant") {
      return item;
    }
  }
  return undefined;
}

function itemsFromMessages(messages: unknown[], tui: TuiAltScreen, cwd: string): Item[] {
  const items: Item[] = [];
  // toolCall blocks from assistant messages, matched to toolResults on replay
  const argsById = new Map<string, { name?: string; args: unknown }>();
  for (const raw of messages) {
    const m = raw as {
      role?: string;
      content?: unknown;
      toolName?: string;
      toolCallId?: string;
      isError?: boolean;
    };
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
        if (block?.type === "toolCall" && block.id) {
          argsById.set(block.id, { name: block.name, args: block.arguments ?? {} });
        }
      }
    }
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
      // Render tool results the way live does - the old replay stub hid
      // the interesting output (command results, file contents).
      if (m.toolName) {
        const call = m.toolCallId ? argsById.get(m.toolCallId) : undefined;
        const component = new ToolExecutionComponent(
          m.toolName,
          m.toolCallId ?? `replay-${items.length}`,
          call?.args ?? {},
          undefined,
          undefined,
          tui,
          cwd,
        );
        component.setArgsComplete();
        component.updateResult({ content: (m.content ?? []) as never, isError: m.isError ?? false }, false);
        items.push({ kind: "tool", component });
      } else {
        const text = userText(m).trim();
        items.push({ kind: "other", component: new Text(dim(`(tool result) ${text.slice(0, 300)}`), 1, 0) });
      }
    }
  }
  return items;
}

function main(): void {
  if (process.argv[2] === "kill-server") {
    void killServer();
    return;
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
