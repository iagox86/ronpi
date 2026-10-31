// Tracks session files open in EXTERNAL pi processes, reported by the
// toriel-presence extension (register on session start, heartbeat every 30s,
// deregister on shutdown). Pure bookkeeping: clock, pid liveness and file
// existence are injectable so it can be tested without real processes.
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionMeta } from "./shared.ts";

export interface ExternalEntry {
  pid: number;
  lastSeen: number;
  cwd?: string;
  /** The session file has existed on disk at some point (ghost detection). */
  seenFile: boolean;
}

export type PruneReason = "deleted" | "exited" | "expired";

export interface PresenceDeps {
  now: () => number;
  pidAlive: (pid: number) => boolean;
  exists: (file: string) => boolean;
}

// The extension's deregister message can be lost when pi exits (the socket
// write races process teardown), so process liveness is the real signal.
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const EXPIRY_MS = 90_000;

export class Presence {
  private entries = new Map<string, ExternalEntry>();
  private deps: PresenceDeps;

  constructor(deps: Partial<PresenceDeps> = {}) {
    this.deps = { now: Date.now, pidAlive, exists: fs.existsSync, ...deps };
  }

  has(file: string): boolean {
    return this.entries.has(file);
  }

  register(file: string, info: { pid: number; cwd?: string }): void {
    const prev = this.entries.get(file);
    this.entries.set(file, {
      pid: info.pid,
      lastSeen: this.deps.now(),
      cwd: info.cwd ?? prev?.cwd,
      seenFile: (prev?.seenFile ?? false) || this.deps.exists(file),
    });
  }

  deregister(file: string): boolean {
    return this.entries.delete(file);
  }

  /** Drop entries whose pi exited, whose file was deleted, or that stopped heartbeating. */
  prune(): Array<{ file: string; reason: PruneReason }> {
    const dropped: Array<{ file: string; reason: PruneReason }> = [];
    const now = this.deps.now();
    for (const [file, e] of this.entries) {
      const exists = this.deps.exists(file);
      e.seenFile = e.seenFile || exists;
      let reason: PruneReason | undefined;
      if (e.seenFile && !exists) {
        reason = "deleted";
      } else if (!this.deps.pidAlive(e.pid)) {
        reason = "exited";
      } else if (now - e.lastSeen > EXPIRY_MS) {
        reason = "expired";
      }
      if (reason) {
        this.entries.delete(file);
        dropped.push({ file, reason });
      }
    }
    return dropped;
  }

  /**
   * Pseudo session entries for externally-live files the daemon does not
   * track itself. Negative ids are never addressable by prompt/attach. They
   * are reported even before pi has written the file; the controller hides
   * them until the file is visible, so a row never exists without its tag.
   */
  pseudoMetas(tracked: Set<string>): SessionMeta[] {
    const metas: SessionMeta[] = [];
    let n = 0;
    for (const [file, e] of this.entries) {
      if (tracked.has(file)) {
        continue;
      }
      const cwd = e.cwd || path.dirname(file);
      metas.push({
        id: -1 - n++,
        cwd,
        model: "external pi",
        sessionFile: file,
        messageCount: 0,
        streaming: false,
        compacting: false,
        dead: false,
        pendingDialog: false,
        active: false,
        attachedToYou: false,
        attachedElsewhere: false,
        externallyLive: true,
      });
    }
    return metas;
  }
}
