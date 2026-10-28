// The daemon's record of one session, and the registry that owns them all.
import type * as net from "node:net";
import type { RpcClient } from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "./agents.ts";
import type { PromptImage } from "./shared.ts";

export interface DaemonSession {
  id: number;
  cwd: string;
  sessionFile?: string;
  /** Live child process; undefined = inactive. */
  child?: RpcClient;
  /** Settings-file mtime (null = no file) and problems when the child started. */
  settingsMtime?: number | null;
  settingsProblem?: string;
  /** Socket holding the exclusive input attach; undefined = nobody. */
  attachedTo?: net.Socket;
  sessionId?: string;
  sessionName?: string;
  model: string;
  provider?: string;
  thinkingLevel?: string;
  ctxTokens?: number | null;
  ctxMax?: number;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
  streaming: boolean;
  dead: boolean;
  pendingDialog: boolean;
  /** A spawn is in flight; prompts arriving meanwhile wait on `starting`. */
  spawning: boolean;
  starting?: Promise<void>;
  /** Last unanswered dialog request, re-sent to newly attached controllers. */
  lastDialog?: Record<string, unknown>;
  /** Set while a manual compaction runs (pi refuses prompts then): messages wait here, in order. */
  held?: HeldPrompt[];
  /** A `!command` the user is running in this session; abort() stops it. */
  localCommand?: AbortController;
  /** The agent profile this session launches with (its tools, prompt, model); undefined = a plain session. */
  agent?: AgentProfile;
  /** Whether the current model takes images (from pi's model entry); undefined = unknown. */
  acceptsImages?: boolean;
}

/** A message sent while a compaction ran, with whatever images came along. */
export interface HeldPrompt {
  text: string;
  images?: PromptImage[];
}

export type LiveSession = DaemonSession & { child: RpcClient };

/** How a command names a session: by daemon id, or by session file. */
export interface SessionRef {
  session?: number;
  path?: string;
}

/**
 * Refuses an operation that restarts or rewrites a session while it is busy.
 * A manual compaction is not an agent run (no agent_start), but restarting
 * or rewinding under it loses it, so it counts as busy too.
 */
export function requireIdle(s: DaemonSession): void {
  if (s.held) {
    throw new Error("session is compacting; wait for it to finish");
  }
  if (s.streaming) {
    throw new Error("session is working; abort it first");
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<number, DaemonSession>();
  private nextId = 1;

  /** A new, inactive session record; registered immediately. */
  create(cwd: string, sessionFile?: string): DaemonSession {
    const s: DaemonSession = {
      id: this.nextId++,
      cwd,
      sessionFile,
      model: "loading",
      messageCount: 0,
      totalTokens: 0,
      totalCost: 0,
      streaming: false,
      dead: false,
      pendingDialog: false,
      spawning: false,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: number): DaemonSession | undefined {
    return this.sessions.get(id);
  }

  byFile(file: string): DaemonSession | undefined {
    return this.all().find((s) => s.sessionFile === file);
  }

  /** The session a command refers to, by id first, else by file path. */
  find(ref: SessionRef): DaemonSession | undefined {
    if (ref.session !== undefined) {
      return this.sessions.get(ref.session);
    }
    return ref.path ? this.byFile(ref.path) : undefined;
  }

  /** The session with a running child; throws when it is unknown or stopped. */
  live(id: number): LiveSession {
    const s = this.sessions.get(id);
    if (!s?.child) {
      throw new Error("session is not active");
    }
    return s as LiveSession;
  }

  delete(id: number): void {
    this.sessions.delete(id);
  }

  /** A snapshot, so callers may add or remove sessions while looping. */
  all(): DaemonSession[] {
    return [...this.sessions.values()];
  }
}
