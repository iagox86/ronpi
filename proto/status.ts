// The status line below the chat box, as pure text composition.
import { visibleWidth } from "@earendil-works/pi-tui";
import { type DialogRequest, dialogPrompt } from "./dialogs.ts";
import { fmtTokens } from "./format.ts";
import { displayName, type LocalSession } from "./session-list.ts";
import type { SessionMeta, UsageReport } from "./shared.ts";
import { accent, attention, dim, gauge } from "./theme.ts";

export interface FleetStats {
  running: number;
  waiting: number;
  tokens: number;
  cost: number;
}

export function fleetStats(metas: Iterable<SessionMeta>): FleetStats {
  const stats: FleetStats = { running: 0, waiting: 0, tokens: 0, cost: 0 };
  for (const m of metas) {
    if (m.streaming) {
      stats.running++;
    }
    if (m.pendingDialog) {
      stats.waiting++;
    }
    stats.tokens += m.tokens ?? 0;
    stats.cost += m.cost ?? 0;
  }
  return stats;
}

export function stateLabel(meta: SessionMeta | undefined): "inactive" | "working" | "crashed" | "idle" {
  if (!meta?.active) {
    return "inactive";
  }
  if (meta.streaming) {
    return "working";
  }
  return meta.dead ? "crashed" : "idle";
}

/**
 * Warning about sessions that started before the ronpi settings file last
 * changed (they keep the old values until they respawn), or about a settings
 * file that did not parse. Empty when there is nothing to say.
 */
export function settingsNotice(metas: Iterable<SessionMeta>, currentMtime: number | null): string {
  let stale = 0;
  let problem = "";
  for (const m of metas) {
    if (!m.active || m.settingsMtime === undefined) {
      continue;
    }
    if (m.settingsProblem) {
      problem = m.settingsProblem;
    }
    if (m.settingsMtime !== currentMtime) {
      stale++;
    }
  }
  if (stale > 0) {
    const noun = stale === 1 ? "running session uses" : "running sessions use";
    return `settings changed - ${stale} ${noun} the old values until restarted`;
  }
  return problem ? `settings problem: ${problem}` : "";
}

export interface StatusInputs {
  switcherOpen: boolean;
  /** Name of the highlighted switcher row, if any. */
  selectedName?: string;
  /** Key of the session on screen; null = none. */
  viewing: string | null;
  meta?: SessionMeta;
  info?: LocalSession;
  stats: FleetStats;
  flash: string;
  dialog?: DialogRequest;
  /** Settings warning (see settingsNotice), shown in the switcher. */
  notice?: string;
  /** What the session is doing right now ("thinking", "running bash"), when it is working. */
  activity?: string;
  /** Terminal width; low-priority segments are dropped to fit. */
  width?: number;
}

/** How costly a model looks by name (0 cheap - 100 expensive); pi has no price tiers to ask. */
export function modelBadness(name: string): number {
  const n = name.toLowerCase();
  if (/(flash|haiku|mini|nano)/.test(n)) {
    return 10;
  }
  if (/(opus|ultra|frontier)/.test(n)) {
    return 100;
  }
  return 55;
}

const EFFORT_BADNESS: Record<string, number> = { off: 0, minimal: 15, low: 30, medium: 50, high: 70, xhigh: 90, max: 100 };

interface Segment {
  text: string;
  /** Higher = dropped first when the line is too wide. */
  drop: number;
}

/** A usage report older than this is not shown: it would be a guess. */
const USAGE_STALE_MS = 30 * 60_000;

/** "5h 16% 7d 4%" for quota windows, or the spend against a budget; undefined when stale or empty. */
export function usageText(usage: UsageReport | undefined, now = Date.now()): string | undefined {
  if (!usage || now - usage.at > USAGE_STALE_MS) {
    return undefined;
  }
  const parts = usage.windows.map((w) => `${w.label} ${gauge(w.pct, `${Math.round(w.pct)}%`)}`);
  if (usage.spend && usage.windows.length === 0) {
    parts.push(`spend $${usage.spend.used.toFixed(2)}`);
  } else if (usage.spend?.max) {
    parts.push(dim(`($${usage.spend.used.toFixed(2)}/$${usage.spend.max.toFixed(2)})`));
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** The viewed session's segments, left to right. */
function sessionSegments(inp: StatusInputs): Segment[] {
  const { meta } = inp;
  const out: Segment[] = [{ text: displayName(meta, inp.info), drop: 0 }];
  const modelId = meta?.model && meta.model !== "loading" ? (meta.model.split("/").pop() as string) : undefined;
  if (modelId) {
    const provider = meta?.provider ? dim(` (${meta.provider})`) : "";
    out.push({ text: `${gauge(modelBadness(modelId), modelId)}${provider}`, drop: 4 });
  }
  const label = meta?.streaming && inp.activity ? inp.activity : stateLabel(meta);
  out.push({ text: label === "crashed" ? attention(label) : label === "idle" || label === "inactive" ? dim(label) : accent(label), drop: 1 });
  if (meta?.ctxMax) {
    const used = meta.ctxTokens;
    if (used === null || used === undefined) {
      out.push({ text: dim(`ctx ?/${fmtTokens(meta.ctxMax)}`), drop: 2 });
    } else {
      const pct = Math.round((used / meta.ctxMax) * 100);
      out.push({ text: `ctx ${gauge(pct, `${fmtTokens(used)}/${fmtTokens(meta.ctxMax)} ${pct}%`)}`, drop: 2 });
    }
  }
  if (meta?.thinkingLevel) {
    out.push({ text: `think ${gauge(EFFORT_BADNESS[meta.thinkingLevel] ?? 50, meta.thinkingLevel)}`, drop: 5 });
  }
  const usage = usageText(meta?.usage);
  if (usage) {
    out.push({ text: usage, drop: 4 });
  }
  if (meta?.cost) {
    out.push({ text: `$${meta.cost.toFixed(meta.cost < 0.1 ? 3 : 2)}`, drop: 3 });
  }
  if (meta?.attachedElsewhere) {
    out.push({ text: attention("VIEW-ONLY"), drop: 0 });
  }
  if (meta?.externallyLive) {
    out.push({ text: attention("LIVE-IN-PI"), drop: 0 });
  }
  return out;
}

/** Join segments, dropping the least important ones until the line fits `width`. */
function fit(segments: Segment[], width: number | undefined): string {
  const sep = dim(" | ");
  const keep = [...segments];
  const joined = () => keep.map((x) => x.text).join(sep);
  while (width !== undefined && keep.length > 1 && visibleWidth(joined()) > width) {
    const worst = Math.max(...keep.map((x) => x.drop));
    if (worst === 0) {
      break;
    }
    keep.splice(keep.findLastIndex((x) => x.drop === worst), 1);
  }
  return joined();
}

export function buildStatusLine(inp: StatusInputs): string {
  const { stats } = inp;
  const counts = `${stats.running} running, ${stats.waiting} waiting`;
  if (inp.dialog) {
    return accent(dialogPrompt(inp.dialog));
  }
  if (inp.flash) {
    return accent(inp.flash);
  }
  if (inp.switcherOpen) {
    const base = dim(
      inp.selectedName
        ? `switcher - ${inp.selectedName} - enter open, arrows navigate, / for commands`
        : "switcher - esc or left closes",
    );
    // a warning replaces the hints rather than trailing them, so a narrow
    // terminal truncates the hints, not the warning
    return inp.notice ? `${dim("switcher")}${dim(" | ")}${attention(inp.notice)}` : base;
  }
  if (!inp.viewing) {
    return dim(`${counts} | left: switcher`);
  }
  return fit(sessionSegments(inp), inp.width);
}
