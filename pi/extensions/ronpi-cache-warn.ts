// ronpi cache warning: before a prompt is sent into a large context whose
// provider-side prompt cache has probably expired, say so (a notice only: the
// prompt is always sent). A cold cache makes the whole context bill as fresh input.
//
// No TTL table: each provider/model's expiry is learned from the session's own
// usage records. A turn whose prompt was mostly cacheRead was a hit after the
// gap since the previous turn; one that was almost all fresh input was a miss.
// The longest hit gap and shortest miss gap per model are kept in
// ~/.config/ronpi/cache-ttl.json, and the existing session history is replayed
// on start so a long-lived session teaches it immediately. With no miss seen
// yet nothing is warned: a wrong warning is worse than none.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Only the slice of pi's extension API this file uses (see ronpi-usage.ts).
interface Usage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}
interface AssistantMessage {
  role: string;
  provider?: string;
  model?: string;
  timestamp?: number;
  usage?: Usage;
}
interface Entry {
  type: string;
  message?: AssistantMessage;
}
interface Ctx {
  model?: { provider: string; id: string; cost?: { input?: number; cacheRead?: number } };
  sessionManager: { getBranch(): Entry[] };
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}
interface Pi {
  on(event: "session_start", handler: (event: unknown, ctx: Ctx) => void): unknown;
  on(event: "message_end", handler: (event: { message: AssistantMessage }, ctx: Ctx) => void): unknown;
  on(event: "input", handler: (event: { source: string }, ctx: Ctx) => Promise<{ action: "continue" }>): unknown;
}

/** What has been seen for one provider/model. Gaps are milliseconds between consecutive turns. */
export interface Learned {
  /** Longest gap after which the cache was still warm. */
  maxHit: number;
  /** Shortest gap (at least MIN_GAP_MS) after which it was cold. */
  minMiss: number;
}
export type Table = Record<string, Learned>;

/** Shorter gaps cannot be expiry: a miss there means the prompt prefix changed. */
export const MIN_GAP_MS = 60_000;
/** Prompts smaller than this are too small to tell a hit from a miss, or to matter. */
export const MIN_PROMPT_TOKENS = 2_000;
export const NOTIFY_TOKENS = 50_000;

export const TABLE_FILE = path.join(os.homedir(), ".config", "ronpi", "cache-ttl.json");

export const promptTokens = (u: Usage): number => (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);

/** "hit" when most of the prompt came from cache, "miss" when almost none did, else unclear. */
export function classify(u: Usage): "hit" | "miss" | undefined {
  const total = promptTokens(u);
  if (total < MIN_PROMPT_TOKENS) {
    return undefined;
  }
  const share = (u.cacheRead ?? 0) / total;
  if (share >= 0.5) {
    return "hit";
  }
  return share < 0.1 ? "miss" : undefined;
}

/** Fold one observed turn (the gap since the previous one, and how its cache went) into the table. */
export function learn(table: Table, key: string, gapMs: number, usage: Usage): boolean {
  const kind = classify(usage);
  if (!kind || gapMs <= 0) {
    return false;
  }
  const entry = table[key] ?? { maxHit: 0, minMiss: Infinity };
  const before = JSON.stringify(entry);
  if (kind === "hit") {
    entry.maxHit = Math.max(entry.maxHit, gapMs);
  } else if (gapMs >= MIN_GAP_MS) {
    entry.minMiss = Math.min(entry.minMiss, gapMs);
  }
  table[key] = entry;
  return JSON.stringify(entry) !== before;
}

/** Replay a branch's assistant messages through `learn`. Returns whether the table changed. */
export function learnFromHistory(table: Table, entries: Entry[]): boolean {
  let changed = false;
  let prev: AssistantMessage | undefined;
  for (const e of entries) {
    const m = e.type === "message" ? e.message : undefined;
    if (m?.role !== "assistant" || !m.usage || !m.timestamp) {
      continue;
    }
    if (prev?.timestamp && prev.model === m.model && prev.provider === m.provider) {
      changed = learn(table, `${m.provider}/${m.model}`, m.timestamp - prev.timestamp, m.usage) || changed;
    }
    prev = m;
  }
  return changed;
}

/** The gap beyond which the cache is expected cold, or undefined while unknown. */
export function threshold(l: Learned | undefined): number | undefined {
  if (!l || !Number.isFinite(l.minMiss)) {
    return undefined;
  }
  // a hit longer than the shortest miss means misses had other causes; trust the hits
  return Math.max(l.minMiss, l.maxHit + 1);
}

export function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 120 ? `${Math.round(min / 60)}h` : `${Math.max(min, 1)}m`;
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

/** The warning for sending now, or undefined when the cache is expected warm, unknown, or the context small. */
export function warningFor(
  last: AssistantMessage | undefined,
  learned: Learned | undefined,
  cost: { input?: number; cacheRead?: number } | undefined,
  now: number,
): string | undefined {
  const limit = threshold(learned);
  if (!last?.usage || !last.timestamp || limit === undefined) {
    return undefined;
  }
  const idle = now - last.timestamp;
  const tokens = promptTokens(last.usage);
  if (idle < limit || tokens < NOTIFY_TOKENS) {
    return undefined;
  }
  let extra = "";
  if (cost?.input) {
    const dollars = (tokens * (cost.input - (cost.cacheRead ?? 0))) / 1_000_000;
    extra = dollars >= 0.005 ? ` (about $${dollars.toFixed(2)} more than a cached prompt)` : "";
  }
  return `Prompt cache has probably expired (idle ${fmtDuration(idle)}; this model's cache has gone cold after ${fmtDuration(limit)}). About ${fmtTokens(tokens)} tokens will be billed as fresh input${extra}.`;
}

function load(file: string): Table {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Table;
  } catch {
    return {};
  }
}

function save(file: string, table: Table): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Infinity is not JSON; an unseen miss is stored as null
    fs.writeFileSync(file, JSON.stringify(table, (_k, v) => (v === Infinity ? null : v), 2));
  } catch {
    // a nicety: losing the table only delays the warning
  }
}

export default function (pi: Pi) {
  const file = process.env.RONPI_CACHE_TTL_FILE ?? TABLE_FILE;
  const table = load(file);
  for (const l of Object.values(table)) {
    l.minMiss ??= Infinity;
  }
  let prev: AssistantMessage | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (learnFromHistory(table, ctx.sessionManager.getBranch())) {
      save(file, table);
    }
    const lastAssistant = ctx.sessionManager
      .getBranch()
      .map((e) => e.message)
      .filter((m): m is AssistantMessage => m?.role === "assistant" && Boolean(m.usage))
      .pop();
    prev = lastAssistant;
  });

  pi.on("message_end", (event, _ctx) => {
    const m = event.message;
    if (m.role !== "assistant" || !m.usage || !m.timestamp) {
      return;
    }
    if (prev?.timestamp && prev.model === m.model && prev.provider === m.provider) {
      if (learn(table, `${m.provider}/${m.model}`, m.timestamp - prev.timestamp, m.usage)) {
        save(file, table);
      }
    }
    prev = m;
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !ctx.model || !prev || prev.model !== ctx.model.id) {
      return { action: "continue" };
    }
    const warning = warningFor(prev, table[`${prev.provider}/${prev.model}`], ctx.model.cost, Date.now());
    if (!warning) {
      return { action: "continue" };
    }
    ctx.ui.notify(warning, "warning");
    return { action: "continue" };
  });
}
