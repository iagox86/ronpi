// Wire protocol between the daemon and controllers: JSONL over a unix socket.
// Framing is LF-only (never readline: U+2028/U+2029 are legal inside JSON strings).
//
// Model: the daemon tracks SESSIONS; a session may have a live child process
// (active: streaming or idle) or not (inactive: file only, lazily respawned).
// A live session's input is exclusively attached to one controller socket;
// every connected controller still sees the full event stream (viewing is
// never exclusive).

/** One quota window of a provider account, e.g. z.ai's rolling 5h. */
export interface UsageWindow {
  label: string;
  /** Percent of the window used, 0-100. */
  pct: number;
  /** When the window resets (ms since epoch). */
  resetsAt?: number;
}

/**
 * An account's usage as reported by whatever can see it (a pi extension for pi
 * providers; a Claude Code adapter later). Backend-neutral on purpose: the
 * daemon keeps the newest report per provider, and the status bar only needs
 * windows and/or a spend figure.
 */
export interface UsageReport {
  v: 1;
  provider: string;
  /** Which adapter produced it ("zai", "litellm", later "claude-code"). */
  source: string;
  plan?: string;
  windows: UsageWindow[];
  spend?: { used: number; max?: number; resetsAt?: number };
  /** When it was fetched (ms since epoch). */
  at: number;
}

export interface SessionMeta {
  /** Daemon-assigned short id, stable for the daemon's lifetime. */
  id: number;
  cwd: string;
  /** Explicit session name; undefined until the session has been named. */
  sessionName?: string;
  model: string;
  /** Session UUID (from the session file header), when known. */
  sessionId?: string;
  /** Absolute path of the session file, when known. */
  sessionFile?: string;
  messageCount: number;
  streaming: boolean;
  /** Child crashed or exited unexpectedly; session can be respawned. */
  dead: boolean;
  /** False when the child has been deactivated (session is file-only). */
  active: boolean;
  pendingDialog: boolean;
  /** ronpi settings-file mtime this child started with (null = no file); undefined when inactive. */
  settingsMtime?: number | null;
  /** Problems the settings file had when this child started. */
  settingsProblem?: string;
  /** The session file is open in an external pi process (presence ext). */
  externallyLive?: boolean;
  /** The child has the session bridge extension (inter-session messages skip pi's steering queue). */
  sessionBridge?: boolean;
  /** Upstream provider id of the current model (e.g. "zai-coding-cn", "litellm"). */
  provider?: string;
  thinkingLevel?: string;
  /** Tokens in the model's context now; null right after a compaction until its next reply. */
  ctxTokens?: number | null;
  ctxMax?: number;
  /** The provider account's latest usage report, shared by every session on that provider. */
  usage?: UsageReport;
  /** Lifetime token/cost rollup tracked by the daemon. */
  tokens?: number;
  cost?: number;
  /** Agent profile the session was started as, when it was. */
  agent?: string;
  /** Whether the current model takes images; undefined when pi did not say. */
  acceptsImages?: boolean;
  /** True iff THIS receiving controller holds the exclusive input attach. */
  attachedToYou: boolean;
  /** True iff another controller holds the attach. */
  attachedElsewhere: boolean;
}

// controller -> daemon. Commands with an `id` get a {type:"response", id}.
export type ClientCommand = ClientCommandBody & { id?: string };

export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

type ClientCommandBody =
  | {
      type: "prompt";
      id?: string;
      message: string;
      /** Pasted images sent with the message (base64 data, as pi's RPC takes them). */
      images?: PromptImage[];
      /** Live session to prompt. */
      session?: number;
      /** Inactive/dead session to (re)spawn and prompt: resume this file. */
      sessionFile?: string;
      /** Required with sessionFile: working directory for the spawned child. */
      cwd?: string;
      /** Optional display name for a newly spawned child. */
      name?: string;
    }
  | { type: "abort"; session: number }
  /** Run a shell command in the session's cwd; pi records it so the model sees it on the next turn. The response is pi's BashResult. */
  | { type: "bash"; session: number; command: string }
  /** Stop a command started with `bash`. */
  | { type: "abort_bash"; session: number }
  /** Drop queued steering/follow-up messages; the response carries their text. */
  | { type: "clear_queue"; session: number }
  /** The text pi's /mcp prints (servers and their states), for listing and completion. */
  | { type: "mcp_status"; session: number }
  /** Deliver a message to another session (UUID, UUID prefix, #number or name). `from` is the sender's UUID, for the label. */
  | { type: "message"; id?: string; to: string; text: string; from?: string }
  /** Find a session from a UUID, UUID prefix, `#number` or name; the response is {uuid, name, file, id?} (id = daemon number when the daemon holds it). */
  | { type: "resolve"; id?: string; query: string }
  /** pi's slash commands (extensions, skills, prompt templates). Without a
   * live session the daemon answers from the last list any child reported. */
  | { type: "commands"; id?: string; session?: number }
  /** `ready`: answer only once the child is up (for callers about to command it). */
  | { type: "spawn"; id?: string; cwd: string; sessionFile?: string; name?: string; agent?: string; ready?: boolean }
  | { type: "deactivate"; id?: string; session: number }
  /** Deactivate if live, then move the session file to the trash dir. */
  | { type: "delete"; id?: string; session?: number; path?: string }
  /** Cut the session back to before a user message (tail goes to the trash). */
  | { type: "rewind"; id?: string; session?: number; path?: string; entryId: string }
  /** Live: setSessionName on the child. Inactive: append session_info to the file. */
  | { type: "rename"; id?: string; session?: number; path?: string; name: string }
  /** Acquire exclusive input attach (force: steal from another controller). */
  | { type: "attach"; id?: string; session: number; force?: boolean }
  | { type: "detach"; session: number }
  | { type: "ui_response"; session: number; response: Record<string, unknown> }
  /** Orderly daemon shutdown (children stop too). */
  | { type: "shutdown" }
  /** Presence heartbeat from the ronpi-presence extension in an external
   * pi process (live=false deregisters on shutdown). */
  | { type: "external_register"; pid: number; sessionFile: string; cwd: string; live: boolean }
  /** Fork an external session file into a new ronpi-owned session.
   * `fork` forks even a file a live ronpi session already owns (/fork).
   * `name` names the new session; `parentName` is what the parent is called
   * (recorded in the lineage the two sessions are told about). */
  | { type: "adopt"; id?: string; path: string; cwd: string; fork?: boolean; name?: string; parentName?: string }
  /** Without `query`: the current model and the available ones. With it: switch to the match. */
  | { type: "model"; id?: string; session: number; query?: string }
  /** Compact the session's context (refused mid-run); can take minutes. */
  | { type: "compact"; id?: string; session: number; instructions?: string }
  /** Wipe the conversation but keep the session (file, name, model); old contents go to the trash dir. Refused mid-run. */
  | { type: "clear"; id?: string; session: number }
  /** Move a deleted session back out of the trash (`trashedTo` is the file in the trash dir). */
  | { type: "restore"; id?: string; trashedTo: string }
  /** Undo the last /clear: put the old contents back (refused mid-run). */
  | { type: "restore_clear"; id?: string; session?: number; path?: string }
  /** Restart the child on the same file so it re-reads extensions, skills and settings. */
  | { type: "reload"; id?: string; session: number }
  /** Controller announce: classifies the connection as a controller (not a
   * presence heartbeat) and requests the current session list. */
  | { type: "list" }
  /** Send this controller the session's current history again (drift cure). */
  | { type: "resync"; id?: string; session: number };

// daemon -> controller
export type DaemonMessage =
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "event"; session: number; event: Record<string, unknown> }
  | { type: "history"; session: number; messages: unknown[] }
  | { type: "ui_request"; session: number; request: Record<string, unknown> }
  | { type: "exited"; session: number; reason?: string }
  /** How many messages pi holds, sent when a run settles; a controller whose count differs asks to resync. */
  | { type: "digest"; session: number; messages: number; streaming: boolean }
  | { type: "response"; id: string; ok: boolean; error?: string; data?: unknown };

export function encodeLine(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

export class LineSplitter {
  private buf = "";

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    for (let idx = this.buf.indexOf("\n"); idx !== -1; idx = this.buf.indexOf("\n")) {
      let line = this.buf.slice(0, idx);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.buf = this.buf.slice(idx + 1);
      if (line.length > 0) {
        lines.push(line);
      }
    }
    return lines;
  }
}
