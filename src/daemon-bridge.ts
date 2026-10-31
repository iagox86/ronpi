// Session bridges: the toriel-session-bridge extension in a child pi process
// takes injection requests delivered as /toriel-inject commands over the child's
// own RPC pipe, delivers them as toriel-inject custom messages at turn
// boundaries (never pi's text-matched steering queue), and pi's message_start
// events confirm each append - the daemon acks from those events, so delivery
// is a fact, not an inference (see docs/design.md, "Session bridge"). This
// tracker holds what was handed out but not yet confirmed, and remembers which
// sessions have been warned about running without the extension.
export interface BridgePending {
  id: string;
  text: string;
}

export class BridgeTracker {
  private readonly outstanding = new Map<number, BridgePending[]>();
  private readonly warned = new Set<number>();
  private nextId = 1;

  /** One id per inject; the extension echoes it back in the custom message's details. */
  newId(): string {
    return `b${this.nextId++}`;
  }

  /** Record an inject the daemon just handed to a bridge (the strip may show it). */
  track(sessionId: number, pending: BridgePending): void {
    const list = this.outstanding.get(sessionId) ?? [];
    list.push(pending);
    this.outstanding.set(sessionId, list);
  }

  /** One outstanding inject was appended to the transcript (or is otherwise settled). */
  ack(sessionId: number, id: string): void {
    const list = this.outstanding.get(sessionId);
    if (!list) {
      return;
    }
    const rest = list.filter((p) => p.id !== id);
    if (rest.length > 0) {
      this.outstanding.set(sessionId, rest);
    } else {
      this.outstanding.delete(sessionId);
    }
  }

  /** A bridge could not deliver: hand the text back so the caller can fall back to steering. */
  fail(sessionId: number, id: string): BridgePending | undefined {
    const list = this.outstanding.get(sessionId);
    if (!list) {
      return undefined;
    }
    const i = list.findIndex((p) => p.id === id);
    if (i === -1) {
      return undefined;
    }
    const [taken] = list.splice(i, 1);
    return taken;
  }

  /** The texts still unconfirmed, in delivery order. */
  texts(sessionId: number): string[] {
    return (this.outstanding.get(sessionId) ?? []).map((p) => p.text);
  }

  /** Forget a session's outstanding injects (the child went away); returns what was never confirmed. */
  clear(sessionId: number): BridgePending[] {
    const lost = this.outstanding.get(sessionId) ?? [];
    this.outstanding.delete(sessionId);
    this.warned.delete(sessionId);
    return lost;
  }

  /** Warn once per session that it has no bridge (the #14 hook). */
  shouldWarnLegacy(sessionId: number): boolean {
    if (this.warned.has(sessionId)) {
      return false;
    }
    this.warned.add(sessionId);
    return true;
  }
}

/** What the strip should show: compaction-held messages first, then the bridge's pending. */
export function mergedQueueTexts(held: string[], bridgeOutstanding: string[]): string[] {
  return [...held, ...bridgeOutstanding];
}

/** The name of the extension command injects travel as; also how the daemon detects the bridge. */
export const INJECT_COMMAND = "toriel-inject";

/** The custom message type the bridge appends. */
export const INJECT_TYPE = "toriel-inject";

/** The id of the inject a pi event shows being appended to the transcript, if it is one. */
export function injectedId(event: Record<string, unknown>): string | undefined {
  const entry = event.type === "entry_appended" ? (event.entry as Record<string, unknown> | undefined) : undefined;
  const message = event.type === "message_end" ? (event.message as Record<string, unknown> | undefined) : undefined;
  const found = entry ?? message;
  if (!found || found.customType !== INJECT_TYPE) {
    return undefined;
  }
  const id = (found.details as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

/** A parsed "toriel-bridge" status record from the extension. */
export type BridgeReport =
  | { kind: "injected"; id: string }
  | { kind: "failed"; id: string; error: string }
  | { kind: "requeued"; ids: string[] };

export const BRIDGE_STATUS_KEY = "toriel-bridge";

/** The report in a setStatus record from the bridge extension, or undefined when it is not one (or is malformed). */
export function parseBridgeReport(event: Record<string, unknown>): BridgeReport | undefined {
  if (event.method !== "setStatus" || event.statusKey !== BRIDGE_STATUS_KEY) {
    return undefined;
  }
  try {
    const r = JSON.parse(String(event.statusText)) as { v?: number; kind?: string; id?: unknown; ids?: unknown; error?: unknown };
    if (r.v !== 1) {
      return undefined;
    }
    if (r.kind === "injected" && typeof r.id === "string") {
      return { kind: "injected", id: r.id };
    }
    if (r.kind === "failed" && typeof r.id === "string") {
      return { kind: "failed", id: r.id, error: String(r.error ?? "unknown error") };
    }
    if (r.kind === "requeued" && Array.isArray(r.ids)) {
      return { kind: "requeued", ids: r.ids.map(String) };
    }
  } catch {
    // fall through
  }
  return undefined;
}
