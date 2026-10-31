// toriel session bridge: takes injection requests from the toriel daemon as the
// extension command `/toriel-inject {"id","text"}` (sent over the child's own RPC
// pipe, handled at once even mid-run, never entering the user history) and
// delivers each as a `toriel-inject` custom message: at the next turn boundary
// while the agent is working, or by starting a turn when it is idle. pi's own
// text-matched steering queue is never used (see docs/design.md, "Session
// bridge"). Runs only in children the toriel daemon starts (TORIEL_CHILD).
//
// Delivery is confirmed from the transcript: a message counts as delivered once
// its id is in the session branch. The daemon sees the same append as a
// message_start event; this file also reports failures and anything handed to pi
// that never reached the transcript (an abort between the hook and the append),
// which it puts back in the queue.

interface Ctx {
  sessionManager: { getBranch(): Array<{ type?: string; customType?: string; details?: { id?: string } }> };
  ui: { setStatus(key: string, text: string | undefined): void };
}
interface Pi {
  on(event: string, handler: (event: unknown, ctx: Ctx) => unknown): unknown;
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: Ctx) => Promise<void> }): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details: unknown }, options?: { triggerTurn?: boolean }): Promise<void>;
}

export const INJECT_COMMAND = "toriel-inject";
export const CUSTOM_TYPE = "toriel-inject";
export const STATUS_KEY = "toriel-bridge";

interface Pending {
  id: string;
  text: string;
}

/** Parse the argument of `/toriel-inject`; undefined when it is not a well-formed request. */
export function parseInject(args: string): Pending | undefined {
  try {
    const v = JSON.parse(args) as { id?: unknown; text?: unknown };
    if (typeof v.id === "string" && v.id && typeof v.text === "string") {
      return { id: v.id, text: v.text };
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** The custom_message draft pi appends at a boundary. */
export function entryFor(p: Pending) {
  return { type: "custom_message" as const, customType: CUSTOM_TYPE, content: p.text, display: true, details: { id: p.id } };
}

/**
 * The injection queue, apart from pi's API so it can be tested: `pending` waits for
 * a delivery chance, `inflight` was handed to pi and is not yet seen in the transcript.
 */
export class InjectQueue {
  readonly pending: Pending[] = [];
  readonly inflight = new Map<string, Pending>();

  add(p: Pending): void {
    this.pending.push(p);
  }

  /** Everything pending moves to inflight and is returned as entries for pi to append. */
  takeAll(): Pending[] {
    const taken = this.pending.splice(0);
    for (const p of taken) {
      this.inflight.set(p.id, p);
    }
    return taken;
  }

  /** The oldest pending one, moved to inflight (for an idle send). */
  takeOne(): Pending | undefined {
    const p = this.pending.shift();
    if (p) {
      this.inflight.set(p.id, p);
    }
    return p;
  }

  /**
   * Compare inflight with the ids found in the transcript: those present are confirmed
   * (returned). Those missing are put back at the front of the queue in their order when
   * `requeueMissing` (only safe once the run is over; mid-run the append may just be late).
   */
  settle(seen: ReadonlySet<string>, requeueMissing: boolean): { confirmed: string[]; requeued: string[] } {
    const confirmed: string[] = [];
    const back: Pending[] = [];
    for (const [id, p] of this.inflight) {
      if (seen.has(id)) {
        confirmed.push(id);
        this.inflight.delete(id);
      } else if (requeueMissing) {
        back.push(p);
        this.inflight.delete(id);
      }
    }
    this.pending.unshift(...back);
    return { confirmed, requeued: back.map((p) => p.id) };
  }

  /** A send that threw: it is not inflight any more. */
  drop(id: string): void {
    this.inflight.delete(id);
  }
}

export default function (pi: Pi) {
  if (!process.env.TORIEL_CHILD) {
    return;
  }
  const queue = new InjectQueue();
  let ui: Ctx["ui"] | undefined;
  let busy = false;
  let pumping = false;

  const report = (r: Record<string, unknown>): void => {
    ui?.setStatus(STATUS_KEY, JSON.stringify({ v: 1, ...r }));
  };

  const idsInTranscript = (ctx: Ctx): Set<string> => {
    const ids = new Set<string>();
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "custom_message" && e.customType === CUSTOM_TYPE && typeof e.details?.id === "string") {
        ids.add(e.details.id);
      }
    }
    return ids;
  };

  /** Check what was handed to pi against the transcript: confirm what landed, requeue what did not. */
  const settle = (ctx: Ctx, requeueMissing: boolean): void => {
    if (queue.inflight.size === 0) {
      return;
    }
    const { confirmed, requeued } = queue.settle(idsInTranscript(ctx), requeueMissing);
    for (const id of confirmed) {
      report({ kind: "injected", id });
    }
    if (requeued.length > 0) {
      report({ kind: "requeued", ids: requeued });
    }
  };

  /** Deliver pending messages one at a time while the session is idle. */
  const pump = async (): Promise<void> => {
    if (pumping || busy) {
      return;
    }
    pumping = true;
    try {
      while (!busy) {
        const p = queue.takeOne();
        if (!p) {
          break;
        }
        try {
          await pi.sendMessage({ customType: CUSTOM_TYPE, content: p.text, display: true, details: { id: p.id } }, { triggerTurn: true });
        } catch (err) {
          queue.drop(p.id);
          report({ kind: "failed", id: p.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      pumping = false;
    }
  };

  const atBoundary = (state: { outcome?: string }) => {
    if (state.outcome === "aborted" || queue.pending.length === 0) {
      return undefined;
    }
    return { entries: queue.takeAll().map(entryFor), continue: true };
  };

  pi.registerCommand(INJECT_COMMAND, {
    description: "toriel internal: deliver a message from another session (JSON {id, text})",
    handler: async (args, ctx) => {
      ui = ctx.ui;
      const p = parseInject(args);
      if (!p) {
        report({ kind: "failed", id: "", error: "malformed /toriel-inject request" });
        return;
      }
      queue.add(p);
      void pump();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
  });
  pi.on("agent_start", () => {
    busy = true;
  });
  pi.on("turn_end", (event) => atBoundary(event as { outcome?: string }));
  pi.on("agent_before_settle", (event) => atBoundary(event as { outcome?: string }));
  pi.on("turn_start", (_event, ctx) => {
    settle(ctx, false);
  });
  pi.on("agent_settled", (_event, ctx) => {
    busy = false;
    settle(ctx, true);
    void pump();
  });
  pi.on("session_shutdown", () => {
    // whatever is still queued dies with this process; the daemon sees the child go and says so
    queue.pending.length = 0;
    queue.inflight.clear();
    busy = false;
    pumping = false;
    ui = undefined;
  });
}
