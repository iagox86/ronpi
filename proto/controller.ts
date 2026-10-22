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
import * as path from "node:path";
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
import { parseCommand } from "./commands.ts";
import { DIALOG_METHODS, SOCK } from "./config.ts";
import { type DialogRequest, dialogAnswer } from "./dialogs.ts";
import { configureEditorKeys, InputEditor, isPlainLeft } from "./editor.ts";
import { fmtAge, lastLine } from "./format.ts";
import { loadGroups, resolveGroup, saveGroups, type GroupsFile } from "./groups.ts";
import { ensureDaemon, killServer } from "./lifecycle.ts";
import { selectListTheme } from "./pi-theme.ts";
import {
  buildSessionList,
  deleteEmptyGroup,
  moveGroup,
  moveSession,
  sessionKey,
  sortSessions,
  type LocalSession,
  type MutationResult,
} from "./session-list.ts";
import { type ClientCommand, type DaemonMessage, type DistributiveOmit, encodeLine, LineSplitter, type SessionMeta } from "./shared.ts";
import { buildStatusLine, fleetStats } from "./status.ts";
import { dim } from "./theme.ts";
import { Switcher, type SwitcherSession } from "./switcher.ts";
import {
  applyEvent,
  type Item,
  itemsFromFile,
  itemsFromMessages,
  newView,
  type SessionView,
} from "./transcript.ts";

configureEditorKeys();
const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: selectListTheme,
};

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
    this.switcher.onShiftSession = (delta, s) => void this.moveSession(delta, s);
    this.switcher.onShiftGroup = (delta, title) => void this.moveGroup(delta, title);
  }

  async run(): Promise<void> {
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
            void this.prompt(queuedPrompt);
          }
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
    const list = buildSessionList({
      daemon: this.sessions.values(),
      local: this.local,
      groups: this.groups,
      summaries: this.summaries,
      now: Date.now(),
    });
    // Freeze the display order while the switcher is open.
    if (this.switchOrder === null) {
      this.switchOrder = list.map((s) => s.key);
    }
    sortSessions(list, this.groups.order ?? [], this.switchOrder);
    if (process.env.RONPI_KEYS) {
      try {
        fs.appendFileSync(process.env.RONPI_KEYS, `REFRESH_SWITCHER paths=${list.length} local=${this.local.size} daemon=${this.sessions.size}: ${list.map((x) => x.key.split("/").pop()).join(",")}\n`);
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
      this.views.set(s.key, { items: itemsFromFile(s.key, this.tui, s.cwd ?? process.cwd()), tools: new Map() });
    }
    this.closeSwitcher();
    this.rebuildChat();
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

  /** Persist a group/order mutation and refresh; shows the mutation's hint. */
  private applyGroupChange(result: MutationResult): void {
    if (result.hint) {
      this.switcher.hint = result.hint;
    }
    if (result.changed) {
      saveGroups(this.groups);
      this.refreshSwitcher();
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
    this.applyGroupChange(moveSession(this.groups, this.switcher.sessions, s, delta));
  }

  /** shift+up/down on a group header: swap with the neighboring group. */
  async moveGroup(delta: number, title: string): Promise<void> {
    this.applyGroupChange(moveGroup(this.groups, title, delta));
  }

  /** ctrl-x on a group header: delete it (only when it has no sessions). */
  async deleteGroupIfEmpty(title: string): Promise<void> {
    this.applyGroupChange(deleteEmptyGroup(this.groups, this.switcher.sessions, title));
  }

  async runCommand(cmd: string, target: SwitcherSession | undefined): Promise<void> {
    const { name, arg } = parseCommand(cmd);
    switch (name) {
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
    const fields = dialogAnswer(dialog, data);
    if (!fields) {
      return false;
    }
    this.send({
      type: "ui_response",
      session: meta.id,
      response: { type: "extension_ui_response", id: dialog.id, ...fields },
    });
    view.dialog = undefined;
    this.renderChrome();
    return true;
  }

  submit(text: string): void {
    if (process.env.RONPI_KEYS) {
      try {
        fs.appendFileSync(process.env.RONPI_KEYS, `SUBMIT ${JSON.stringify(text)} open=${this.switcherOpen}\n`);
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
    const stats = fleetStats(this.sessions.values());
    this.switcher.counts = { running: stats.running, waiting: stats.waiting };
    this.switcher.budget = { cost: stats.cost, tokens: stats.tokens };
    this.switcher.height = this.tui.terminal.rows || 24;
    const status = buildStatusLine({
      switcherOpen: this.switcherOpen,
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
