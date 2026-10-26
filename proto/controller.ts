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
import { DIALOG_METHODS, HISTORY_FILE, KEY_LOG, SOCK } from "./config.ts";
import { type DialogRequest, DialogPanel, isTextDialog } from "./dialogs.ts";

// How long a reason typed on the select waits for the chained input dialog.
const REASON_FRESH_MS = 10_000;
import { configureEditorKeys, InputEditor, } from "./editor.ts";
import { lastLine } from "./format.ts";
import { RewindPicker } from "./rewind-picker.ts";
import { CommandAutocomplete } from "./autocomplete.ts";
import { HistorySearch } from "./history-search.ts";
import { settingsMtime } from "./settings.ts";
import { loadCommands, mergeHistory, recordCommand, trimCommands } from "./history.ts";
import { rewindTargets } from "./rewind.ts";
import { autocompleteMaxVisible, hideThinkingBlock, wheelScrollLines } from "./pi-settings.ts";
import { SessionActions } from "./session-actions.ts";
import { SwitcherActions } from "./switcher-actions.ts";
import { ensureDaemon, killServer } from "./lifecycle.ts";
import { selectListTheme } from "./pi-theme.ts";
import {
  sessionKey,
  type LocalSession,
} from "./session-list.ts";
import { type ClientCommand, type DaemonMessage, type DistributiveOmit, encodeLine, LineSplitter, type SessionMeta } from "./shared.ts";
import { buildStatusLine, fleetStats, settingsNotice } from "./status.ts";
import { ActivityLine } from "./activity.ts";
import { Dimmed } from "./components.ts";
import { ChoicePanel } from "./choice-panel.ts";
import { InfoPanel } from "./info-panel.ts";
import { type McpServer, parseMcpStatus } from "./mcp.ts";
import type { ToolRun } from "./tool-run.ts";
import { assertTruecolor, dim, OSC_RESET_BG, OSC_SET_BG } from "./theme.ts";
import { Switcher, } from "./switcher.ts";
import {
  applyEvent,
  dropEcho,
  echoUser,
  type Item,
  itemsFromMessages,
  newView,
  type SessionView,
  showRawError,
} from "./transcript.ts";

configureEditorKeys();
const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: selectListTheme,
};

/** Only the newest tool run advertises ctrl-o; the hint on every line is noise. */
function markLatestRun(view: SessionView): void {
  const runs = view.items.filter((i) => i.kind === "tools");
  runs.forEach((run, i) => {
    (run.component as ToolRun).showHint = i === runs.length - 1;
  });
}

const SWITCHER_HISTORY = "<switcher>";

class Controller {
  tui: TuiAltScreen;
  chatRoot = new Container();
  chatLayout: VStack;
  switcherLayout: VStack;
  scroll: ScrollView;
  statusLine = new Text("", 0, 0);
  activityLine = new ActivityLine();
  dialogPanel = new DialogPanel();
  infoPanel = new InfoPanel();
  choicePanel = new ChoicePanel();
  rewindPicker = new RewindPicker();
  historySearch = new HistorySearch();
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
  /** pi's slash commands for the viewed session (from the daemon). */
  piCommands: Array<{ name: string; description?: string }> = [];
  private commandsFor: string | null = null;
  /** Editor text from before ctrl-r, restored on cancel. */
  private searchDraft = "";
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
    this.editor.setAutocompleteMaxVisible(autocompleteMaxVisible());
    this.editor.setAutocompleteProvider(
      new CommandAutocomplete(() => ({
        switcher: this.switching.isOpen,
        piCommands: this.piCommands,
        cwd: (this.viewing && (this.metaForPath(this.viewing)?.cwd ?? this.local.get(this.viewing)?.cwd)) || process.cwd(),
        sources: {
          models: () => this.modelNames(),
          groups: () => this.switching.groups.groups,
          mcpServers: () => this.mcpServers(),
        },
      })),
    );
    this.editor.debugLog = KEY_LOG;
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
      { component: this.dialogPanel, basis: "auto", grow: 0, shrink: 0, minSize: 0 },
      { component: this.infoPanel, basis: "auto", grow: 0, shrink: 0, minSize: 0 },
      { component: this.choicePanel, basis: "auto", grow: 0, shrink: 0, minSize: 0 },
      // never compress the dock: a shrunken editor was the "cut off" bug
      { component: dock, basis: "auto", grow: 0, shrink: 0, minSize: 4 },
    ]);
    this.switcherLayout = new VStack([
      { component: this.switcher, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: this.infoPanel, basis: "auto", grow: 0, shrink: 0, minSize: 0 },
      { component: this.choicePanel, basis: "auto", grow: 0, shrink: 0, minSize: 0 },
      { component: dock, basis: "auto", grow: 0, shrink: 0, minSize: 4 },
    ]);
    this.tui.setLayoutRoot(this.chatLayout);
    this.tui.setFocus(this.editor);

    this.switcher.heightProvider = () => this.tui.terminal.rows || 24;
    this.switcher.debugLog = KEY_LOG;
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
            this.renderChrome(); // picks up a changed settings file
          }
        });
      }, 10_000);
      this.listTimer.unref?.();
      this.switching.startAutoSummary();
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
  request(cmd: DistributiveOmit<ClientCommand, "id">, timeoutMs = 30_000): Promise<unknown> {
    const id = `req-${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      this.responses.set(id, { resolve, reject });
      this.send({ ...cmd, id });
      setTimeout(() => {
        if (this.responses.has(id)) {
          this.responses.delete(id);
          reject(new Error("daemon request timed out"));
        }
      }, timeoutMs).unref?.();
    });
  }

  handleDaemonMessage(msg: DaemonMessage): void {
    switch (msg.type) {
      case "sessions":
        this.onSessions(msg.sessions);
        return;
      case "history":
        this.onHistory(msg.session, msg.messages);
        return;
      case "event": {
        const key = this.keyById(msg.session);
        if (key) {
          this.applyEvent(key, this.viewFor(key), msg.event);
        }
        return;
      }
      case "ui_request":
        this.onUiRequest(msg.session, msg.request as unknown as DialogRequest);
        return;
      case "exited": {
        const meta = this.sessions.get(msg.session);
        if (meta && this.keyFor(meta) === this.viewing) {
          this.notify("child exited");
        }
        return;
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
        return;
      }
    }
  }

  private onSessions(metas: SessionMeta[]): void {
    this.sessionsLoaded = true;
    this.sessions.clear();
    for (const meta of metas) {
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
  }

  private onHistory(sessionId: number, messages: unknown[]): void {
    const key = this.keyById(sessionId);
    if (!key) {
      return;
    }
    const old = this.views.get(key);
    const fresh: SessionView = {
      ...newView(),
      items: itemsFromMessages(messages, this.tui, this.metaForPath(key)?.cwd ?? ""),
      // keep live activity if events raced ahead of the history reply
      activity: old?.activity,
      queue: old?.queue ?? [],
    };
    this.views.set(key, fresh);
    // prompts sent but not yet echoed by pi are not in the child's history
    for (const echo of old?.echoes ?? []) {
      fresh.echoes.push(echo);
      fresh.items.push(echo.item);
    }
    if (key === this.viewing) {
      this.rebuildChat();
    }
  }

  private onUiRequest(sessionId: number, request: DialogRequest | undefined): void {
    const key = this.keyById(sessionId);
    if (!key) {
      return;
    }
    const view = this.viewFor(key);
    if (request && DIALOG_METHODS.has(request.method)) {
      const reason = view.pendingReason;
      view.pendingReason = undefined;
      if (reason && isTextDialog(request) && Date.now() - reason.at < REASON_FRESH_MS) {
        this.send({
          type: "ui_response",
          session: sessionId,
          response: { type: "extension_ui_response", id: request.id, value: reason.text },
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
  }

  /** Models the viewed live session can switch to; cached briefly since completion asks per keystroke. */
  private modelCache?: { session: number; at: number; names: string[] };

  async modelNames(): Promise<string[]> {
    const meta = this.switching.isOpen || !this.viewing ? undefined : this.metaForPath(this.viewing);
    if (!meta?.active) {
      return [];
    }
    const cached = this.modelCache;
    if (cached && cached.session === meta.id && Date.now() - cached.at < 60_000) {
      return cached.names;
    }
    try {
      const r = (await this.request({ type: "model", session: meta.id })) as { models: string[] };
      this.modelCache = { session: meta.id, at: Date.now(), names: r.models };
      return r.models;
    } catch {
      return [];
    }
  }

  /** MCP servers of the viewed session; cached briefly since completion asks per keystroke. */
  private mcpCache?: { session: number; at: number; servers: McpServer[] };

  async mcpServers(): Promise<McpServer[]> {
    const meta = this.switching.isOpen || !this.viewing ? undefined : this.metaForPath(this.viewing);
    if (!meta?.active) {
      return [];
    }
    const cached = this.mcpCache;
    if (cached && cached.session === meta.id && Date.now() - cached.at < 10_000) {
      return cached.servers;
    }
    try {
      const r = (await this.request({ type: "mcp_status", session: meta.id })) as { text: string };
      const servers = parseMcpStatus(r.text);
      this.mcpCache = { session: meta.id, at: Date.now(), servers };
      return servers;
    } catch {
      return [];
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
    if (this.choicePanel.isOpen) {
      const handled = this.choicePanel.keys(data);
      this.tui.requestRender();
      return handled;
    }
    if (this.infoPanel.isOpen) {
      // any key dismisses command output; esc/enter are only for that
      this.infoPanel.close();
      this.tui.requestRender();
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
        return true;
      }
    }
    const view = this.viewing ? this.views.get(this.viewing) : undefined;
    if (view?.dialog && this.session.dialogKeys(view, data)) {
      return true;
    }
    if (this.historySearch.isOpen) {
      return this.searchKeys(data);
    }
    if (matchesKey(data, Key.ctrl("r")) && !this.rewindPicker.isOpen && !this.switching.isOpen) {
      this.searchDraft = this.editor.getText();
      this.historySearch.open(this.currentHistory());
      this.editor.setText(this.historySearch.promptText());
      this.notify("ctrl-r older - ctrl-s newer - enter use - esc cancel");
      this.tui.requestRender();
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
    if (KEY_LOG) {
      try {
        fs.appendFileSync(KEY_LOG, `SUBMIT ${JSON.stringify(text)} open=${this.switching.isOpen}\n`);
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
    // the transcript spinner, or (switcher open) the spinner on streaming rows
    const switcherBusy = this.switching.isOpen && [...this.sessions.values()].some((m) => m.streaming);
    const animate = (Boolean(view?.activity) && !this.switching.isOpen) || switcherBusy;
    if (animate && !this.activityTimer) {
      this.activityTimer = setInterval(() => this.tui.requestRender(), 100);
    } else if (!animate && this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = undefined;
    }
  }

  echoPrompt(key: string, text: string): void {
    const view = this.viewFor(key);
    echoUser(view, text, { addItem: (item) => this.addItem(view, key, item) });
    if (key === this.viewing) {
      this.scroll.scrollToEnd();
      this.syncActivity();
      this.tui.requestRender();
    }
  }

  dropEcho(key: string, text: string): void {
    const view = this.views.get(key);
    if (view && dropEcho(view, text)) {
      if (key === this.viewing) {
        this.rebuildChat();
      }
    }
  }

  /** Mount new items immediately on the viewed session; rebuildChat() mounts the rest. */
  addItem(view: SessionView, key: string, item: Item): void {
    this.applyDisplay(item);
    view.items.push(item);
    if (item.kind === "tools") {
      markLatestRun(view);
    }
    if (key === this.viewing) {
      this.chatRoot.addChild(item.component);
    }
  }

  /** Apply the global display toggles (tools expanded, thinking hidden) to one item. */
  private applyDisplay(item: Item): void {
    if (item.kind === "tools") {
      item.component.expanded = this.toolsExpanded;
    } else if (item.kind === "compaction") {
      item.component.setExpanded(this.toolsExpanded);
    } else if (item.kind === "assistant") {
      // Blank label: the working indicator already says "thinking", so a hidden block leaves no line behind.
      item.component.setHiddenThinkingLabel("");
      item.component.setHideThinkingBlock(this.thinkingHidden);
      item.component.setShowRawError(this.toolsExpanded);
    } else if (item.kind === "other") {
      showRawError(item, this.toolsExpanded);
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
  /** Keys while the ctrl-r search line is open; it swallows everything. */
  private searchKeys(data: string): boolean {
    const result = this.historySearch.handleKey(data);
    if (result === "none") {
      this.editor.setText(this.historySearch.promptText());
    } else {
      this.editor.setText(result === "accept" ? (this.historySearch.current() ?? "") : this.searchDraft);
      this.historySearch.close();
    }
    this.tui.requestRender();
    return true;
  }

  /** History texts (oldest first) for what is on screen. */
  private currentHistory(): string[] {
    let prompts: Array<{ ts: number; text: string }> = [];
    const key = this.viewing;
    if (!this.switching.isOpen && key && fs.existsSync(key)) {
      try {
        prompts = rewindTargets(key);
      } catch {
        // unreadable file: commands only
      }
    }
    return mergeHistory(prompts, loadCommands(HISTORY_FILE));
  }

  syncHistory(force = false): void {
    const token = this.switching.isOpen ? SWITCHER_HISTORY : this.viewing;
    if (!force && token === this.historyFor) {
      return;
    }
    this.editor.setHistory(this.currentHistory());
    this.historyFor = token;
  }

  /** Fetch pi's slash commands for the viewed session, once per session on screen. */
  private syncCommands(): void {
    const key = this.viewing;
    if (!key || key === this.commandsFor) {
      return;
    }
    this.commandsFor = key;
    const session = this.metaForPath(key)?.id;
    this.request({ type: "commands", session })
      .then((list) => {
        if (key === this.commandsFor && Array.isArray(list)) {
          this.piCommands = list as Array<{ name: string; description?: string }>;
          if (list.length === 0) {
            this.commandsFor = null; // no child to ask yet; try again next time
          }
        }
      })
      .catch(() => {
        this.commandsFor = null; // retry on the next view change
      });
  }

  rebuildChat(): void {
    this.syncHistory();
    this.syncCommands();
    this.chatRoot.clear();
    const view = this.viewing ? this.views.get(this.viewing) : undefined;
    if (view) {
      markLatestRun(view);
      for (const item of view.items) {
        this.applyDisplay(item);
        this.chatRoot.addChild(item.dimmed ? new Dimmed(item.component) : item.component);
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
    this.dialogPanel.sync(this.viewing ? this.views.get(this.viewing)?.dialog : undefined);
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
      activity: key ? this.views.get(key)?.activity?.label : undefined,
      width,
      notice: settingsNotice(this.sessions.values(), settingsMtime()),
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
