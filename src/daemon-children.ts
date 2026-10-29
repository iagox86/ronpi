// Starting, stopping and listening to the pi child processes behind sessions.
import * as fs from "node:fs";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { DIALOG_METHODS } from "./config.ts";
import { type BridgeTracker, INJECT_COMMAND, injectedId, mergedQueueTexts, parseBridgeReport } from "./daemon-bridge.ts";
import type { ClientHub } from "./daemon-hub.ts";
import type { DaemonSession } from "./daemon-session.ts";
import { randomUUID } from "node:crypto";
import { type AgentProfile, profileArgs } from "./agents.ts";
import { recordHandled } from "./handled-files.ts";
import { historyOf } from "./daemon-history.ts";
import { RONPI_TOOLS } from "./required.ts";
import { lineageArgs, sessionIdOfFile } from "./lineage.ts";
import { profileOfSession, saveSessionAgent } from "./session-agents.ts";
import { log } from "./log.ts";
import type { UsageReport } from "./shared.ts";
import { type ChildConfig, loadSettings, resolveChildConfig, settingsMtime } from "./settings.ts";

export interface SlashCommand {
  name: string;
  description?: string;
  source: string;
}

export interface StartOptions {
  sessionFile?: string;
  forkPath?: string;
  name?: string;
  /** Launch a new session as this agent profile (a respawn finds its profile on its own). */
  agent?: AgentProfile;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class ChildManager {
  private readonly hub: ClientHub;
  /** Newest usage report per provider (all sessions on a provider share one account). */
  private readonly usage: Map<string, UsageReport>;
  /** Newest slash-command list any child reported; serves sessions with no child. */
  private lastCommands: SlashCommand[] = [];
  /** Sessions waiting for the notice pi's /mcp prints, by daemon session id (see mcpStatus). */
  private readonly noticeTaps = new Map<number, (text: string) => void>();
  /** Injects handed to session bridges and not yet seen in a transcript, so strip re-syncs keep them visible. */
  private readonly bridges: BridgeTracker;

  constructor(hub: ClientHub, usage: Map<string, UsageReport>, bridges: BridgeTracker) {
    this.hub = hub;
    this.usage = usage;
    this.bridges = bridges;
  }

  /**
   * Settings for a child about to start, read fresh so edits apply to new and
   * respawned sessions. Records the file's mtime and any problems on the session
   * so the switcher can say which running sessions are behind.
   */
  configFor(s: DaemonSession): ChildConfig {
    const mtime = settingsMtime();
    const { settings, problems } = loadSettings();
    s.settingsMtime = mtime;
    s.settingsProblem = problems.length > 0 ? problems.join("; ") : undefined;
    if (problems.length > 0) {
      log(`settings problems: ${s.settingsProblem}`);
    }
    return resolveChildConfig(settings);
  }

  /**
   * Start a pi process for `s` with `args` and wire its events in, applying
   * ronpi's queue preference: messages sent while a run is in flight are all
   * delivered together at the next turn boundary (pi's own default is one per
   * turn). Set steeringMode in the ronpi settings to change.
   */
  async launch(s: DaemonSession, args: string[], cfg: ChildConfig): Promise<RpcClient> {
    const client = new RpcClient({
      cliPath: cfg.piCli,
      cwd: s.cwd,
      args,
      env: { ...process.env, RONPI_CHILD: "1", ...(s.sessionId ? { RONPI_SESSION_ID: s.sessionId } : {}) },
    });
    client.onEvent((event) => this.onEvent(s, event as Record<string, unknown>));
    await client.start();
    try {
      await client.setSteeringMode(cfg.steeringMode);
    } catch (err) {
      log(`setSteeringMode(${cfg.steeringMode}) failed: ${errorText(err)}`);
    }
    return client;
  }

  /** Bring an inactive session's child up (from its file, a fork source, or fresh). */
  async start(s: DaemonSession, opts: StartOptions = {}): Promise<void> {
    if (s.child) {
      return;
    }
    s.spawning = true;
    this.hub.broadcastSessions();
    try {
      const useFile = opts.forkPath ? undefined : (opts.sessionFile ?? s.sessionFile);
      const args: string[] = [];
      if (opts.forkPath) {
        args.push("--fork", opts.forkPath);
      } else if (useFile) {
        args.push("--session", useFile);
      }
      if (opts.name) {
        args.push("--name", opts.name);
      }
      args.push(...lineageArgs(useFile ? sessionIdOfFile(useFile) : undefined));
      const cfg = this.configFor(s);
      // The ronpi settings' provider/model/thinking are defaults for NEW sessions.
      // A session that already has a file resumes with its own (pi restores them
      // from the file), so a restart, /reload or /clear must not reset them.
      const isNew = !opts.forkPath && !(useFile && fs.existsSync(useFile));
      // The profile a session was started with is saved by UUID, so lazy respawns, /reload and /clear keep its loadout.
      // Known before pi starts, so the child's tools can say who it is: a new session
      // gets an id chosen here (pi takes --session-id), a resumed one has it in its file.
      if (isNew) {
        s.sessionId = randomUUID();
        args.push("--session-id", s.sessionId);
      } else if (useFile) {
        s.sessionId = sessionIdOfFile(useFile) ?? s.sessionId;
      }
      const agent = opts.agent ?? profileOfSession(useFile ? sessionIdOfFile(useFile) : undefined) ?? s.agent;
      s.agent = agent;
      if (agent) {
        args.push(...profileArgs(agent, { isNew }));
      }
      // A resume restores the tool list recorded in the transcript, so tools of extensions
      // installed since never reach the model. +name entries join them to that loadout. A
      // profile that lists tools owns the loadout (pi forbids mixing the two forms).
      if (!agent?.tools) {
        args.push("--tools", RONPI_TOOLS.join(","));
      }
      if (isNew && cfg.thinking && !agent?.thinking) {
        args.push("--thinking", cfg.thinking);
      }
      if (isNew && cfg.model && !agent?.model) {
        args.push("--model", cfg.model);
      }
      if (isNew && cfg.provider && !agent?.model) {
        args.push("--provider", cfg.provider);
      }
      s.sessionBridge = undefined;
      s.child = await this.launch(s, args, cfg);
      s.dead = false;
      await this.refreshMeta(s);
      await this.detectBridge(s);
      if (opts.agent && s.sessionId) {
        saveSessionAgent(s.sessionId, opts.agent);
      }
      if (s.sessionFile) {
        try {
          recordHandled(s.sessionFile);
        } catch (err) {
          log(`could not record ${s.sessionFile} as handled: ${err instanceof Error ? err.message : err}`);
        }
      }
      log(`session ${s.id} child started (file=${s.sessionFile ?? "new"})`);
    } finally {
      s.spawning = false;
      this.hub.broadcastSessions();
    }
  }

  async deactivate(s: DaemonSession): Promise<void> {
    const child = s.child;
    if (!child) {
      return;
    }
    s.child = undefined;
    s.attachedTo = undefined;
    s.pendingDialog = false;
    s.streaming = false;
    this.dropBridge(s, "the session was stopped");
    try {
      await child.stop();
    } catch {
      // best effort; the process is going away regardless
    }
    log(`session ${s.id} deactivated`);
  }

  /** Restart an idle session's child on the same file, keeping its input attach. */
  async restart(s: DaemonSession): Promise<void> {
    const attached = s.attachedTo;
    await this.deactivate(s);
    s.attachedTo = attached;
    await this.start(s, { sessionFile: s.sessionFile });
  }

  async refreshMeta(s: DaemonSession): Promise<void> {
    if (!s.child) {
      return;
    }
    try {
      const state = await s.child.getState();
      s.model = state.model ? `${state.model.provider}/${state.model.id}` : "default";
      s.sessionId = state.sessionId;
      s.sessionFile = state.sessionFile ?? s.sessionFile;
      s.messageCount = state.messageCount;
      s.streaming = state.isStreaming;
      s.sessionName = state.sessionName;
      s.provider = state.model?.provider;
      s.thinkingLevel = state.thinkingLevel;
      s.ctxMax = state.model?.contextWindow;
      s.acceptsImages = state.model?.input ? state.model.input.includes("image") : undefined;
      s.dead = false;
      // pi's queue_update is the only source of strip state and is not replayed, so
      // one lost event would leave a controller showing "queued" lines forever (the
      // #47 symptom). When pi says nothing is pending, any strip entries beyond our
      // own (compaction-held and bridge-pending) are stale by definition.
      if (state.pendingMessageCount === 0) {
        this.hub.announceQueue(
          s.id,
          [
            ...(s.held ?? []).map((h) => h.text),
            ...this.bridges.texts(s.id),
          ],
        );
      }
      try {
        // whole-session figures from pi, so they survive a daemon restart (our own running sums would not)
        const stats = await s.child.getSessionStats();
        s.totalTokens = stats.tokens.total;
        s.totalCost = stats.cost;
        s.ctxTokens = stats.contextUsage?.tokens;
        s.ctxMax = stats.contextUsage?.contextWindow ?? s.ctxMax;
      } catch (err) {
        log(`session ${s.id} stats failed: ${err}`);
      }
    } catch (err) {
      s.dead = true;
      s.streaming = false;
      this.dropBridge(s, "the session's process stopped answering");
      log(`session ${s.id} refreshMeta failed: ${err}`);
    }
  }

  /** Whether the child has the session bridge extension: it lists the inject command. Remembered on the session. */
  async detectBridge(s: DaemonSession): Promise<boolean> {
    if (!s.child) {
      return false;
    }
    try {
      const commands = await s.child.getCommands();
      s.sessionBridge = commands.some((c) => c.name === INJECT_COMMAND);
    } catch (err) {
      log(`session ${s.id}: could not look for the session bridge: ${errorText(err)}`);
      s.sessionBridge = false;
    }
    return s.sessionBridge === true;
  }

  /** The strip: compaction-held messages first, then injects the bridge has not confirmed yet. */
  private announceQueue(s: DaemonSession): void {
    this.hub.announceQueue(s.id, mergedQueueTexts((s.held ?? []).map((h) => h.text), this.bridges.texts(s.id)));
  }

  /** Injects that never reached a transcript are gone with the process: say so rather than let the sender believe they landed. */
  private dropBridge(s: DaemonSession, why: string): void {
    const lost = this.bridges.clear(s.id);
    s.sessionBridge = undefined;
    if (lost.length === 0) {
      return;
    }
    const reason = `${lost.length} message${lost.length === 1 ? "" : "s"} from other sessions did not arrive (${why}): ${lost.map((p) => JSON.stringify(p.text.replace(/^\[from [^\]]*\]:\s*/, "").slice(0, 60))).join(", ")}`;
    log(`session ${s.id}: ${reason}`);
    this.hub.broadcast({ type: "exited", session: s.id, reason });
    this.announceQueue(s);
  }

  /** Act on a status record from the bridge extension; true if it was one. */
  private takeBridgeReport(s: DaemonSession, event: Record<string, unknown>): boolean {
    const report = parseBridgeReport(event);
    if (!report) {
      return false;
    }
    switch (report.kind) {
      case "injected":
        this.bridges.ack(s.id, report.id);
        this.announceQueue(s);
        break;
      case "failed": {
        const lost = this.bridges.fail(s.id, report.id);
        log(`session ${s.id}: bridge could not deliver ${report.id || "a request"}: ${report.error}`);
        this.announceQueue(s);
        if (lost && s.child) {
          // it never entered the transcript: hand it to pi's own queue so it is not lost
          s.child.prompt(lost.text, undefined, "steer").catch((err: unknown) => log(`session ${s.id}: steering fallback failed: ${errorText(err)}`));
        }
        break;
      }
      case "requeued":
        log(`session ${s.id}: bridge put ${report.ids.join(", ")} back in its queue (not in the transcript yet)`);
        break;
    }
    return true;
  }

  /** The slash commands the session's child offers; falls back to the newest list seen. */
  async slashCommands(s: DaemonSession | undefined): Promise<SlashCommand[]> {
    if (s?.child) {
      try {
        this.lastCommands = await s.child.getCommands();
      } catch (err) {
        log(`get_commands failed: ${errorText(err)}`);
      }
    }
    return this.lastCommands;
  }

  /**
   * The server list pi's /mcp prints. pi shows it as a notice, which we catch
   * here instead of passing on, so asking does not flash it at every controller.
   */
  async mcpStatus(s: DaemonSession, timeoutMs = 20_000): Promise<string> {
    const child = s.child;
    if (!child) {
      throw new Error("session is not active");
    }
    return new Promise<string>((resolve, reject) => {
      const done = (settle: () => void) => {
        clearTimeout(timer);
        this.noticeTaps.delete(s.id);
        settle();
      };
      const timer = setTimeout(
        () => done(() => reject(new Error("no answer from /mcp - is the MCP extension loaded?"))),
        timeoutMs,
      );
      this.noticeTaps.set(s.id, (text) => done(() => resolve(text)));
      child.prompt("/mcp").catch((err: unknown) => done(() => reject(err)));
    });
  }

  /** Keep a "ronpi-usage" status record from a child's usage extension; true if it was one. */
  private takeUsageReport(event: Record<string, unknown>): boolean {
    if (event.method !== "setStatus" || event.statusKey !== "ronpi-usage") {
      return false;
    }
    try {
      const report = JSON.parse(String(event.statusText)) as UsageReport;
      if (report?.v === 1 && typeof report.provider === "string" && Array.isArray(report.windows)) {
        this.usage.set(report.provider, report);
        this.hub.broadcastSessions();
      }
    } catch {
      log("ignored a malformed ronpi-usage record");
    }
    return true;
  }

  /** pi settles a dialog with a `timeout` by itself and says nothing, so the record is dropped then too. */
  private expireDialog(s: DaemonSession, dialog: Record<string, unknown>): void {
    const timeout = Number(dialog.timeout);
    if (!(timeout > 0)) {
      return;
    }
    setTimeout(() => {
      if (s.lastDialog === dialog) {
        this.clearDialog(s);
      }
    }, timeout + 1000).unref();
  }

  private clearDialog(s: DaemonSession): void {
    if (s.pendingDialog) {
      s.pendingDialog = false;
      s.lastDialog = undefined;
      this.hub.broadcastSessions();
    }
  }

  private onEvent(s: DaemonSession, event: Record<string, unknown>): void {
    const type = event.type as string;
    if (type === "extension_ui_request") {
      if (this.takeUsageReport(event) || this.takeBridgeReport(s, event)) {
        return; // for the daemon, not for controllers
      }
      const tap = this.noticeTaps.get(s.id);
      if (tap && event.method === "notify") {
        tap(String(event.message ?? ""));
        return;
      }
      if (DIALOG_METHODS.has(event.method as string)) {
        s.pendingDialog = true;
        s.lastDialog = event;
        this.hub.broadcastSessions();
        this.expireDialog(s, event);
      }
      // Dialogs go to the attached controller; fire-and-forget records and
      // unattached dialogs broadcast so somebody can pick them up.
      const message = { type: "ui_request" as const, session: s.id, request: event };
      if (s.attachedTo) {
        this.hub.send(s.attachedTo, message);
      } else {
        this.hub.broadcast(message);
      }
      return;
    }
    this.hub.broadcast({ type: "event", session: s.id, event });
    // the append itself: the transcript, not an inference, says an inject landed
    const injected = injectedId(event);
    if (injected !== undefined) {
      this.bridges.ack(s.id, injected);
      this.announceQueue(s);
    }
    if (type === "message_end") {
      const usage = (event.message as { usage?: { totalTokens?: number; cost?: { total?: number } } } | undefined)?.usage;
      if (usage) {
        s.totalTokens += usage.totalTokens ?? 0;
        s.totalCost += usage.cost?.total ?? 0;
      }
    }
    if (type === "message_start" || type === "message_end" || type === "agent_start" || type === "agent_settled") {
      log(
        `session ${s.id} event: ${type}${type === "message_end" ? ` stop=${(event.message as { stopReason?: string })?.stopReason}` : ""}`,
      );
    }
    if (type === "queue_update") {
      // queue events were invisible here, which is exactly where a stuck strip hides
      const steering = (event.steering as string[] | undefined) ?? [];
      log(`session ${s.id} event: queue_update steering=${steering.length}`);
    }
    if (type === "agent_start") {
      s.streaming = true;
      this.hub.broadcastSessions();
    } else if (type === "agent_settled") {
      s.streaming = false;
      // no tool can still be asking once the turn is over
      this.clearDialog(s);
      void this.refreshMeta(s).then(() => this.hub.broadcastSessions());
      void this.announceDigest(s);
    }
  }

  /** Tell controllers how many messages pi holds so one that drifted can ask for a resync. */
  private async announceDigest(s: DaemonSession): Promise<void> {
    try {
      // counted the way a history replay is built, so a resync always lands on the same number
      const messages = s.child ? (await historyOf(s)).length : undefined;
      if (messages !== undefined) {
        this.hub.broadcast({ type: "digest", session: s.id, messages, streaming: s.streaming });
      }
    } catch (err) {
      log(`session ${s.id}: digest failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
