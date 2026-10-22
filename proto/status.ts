// The status line below the chat box, as pure text composition.
import { type DialogRequest, dialogPrompt } from "./dialogs.ts";
import { fmtTokens } from "./format.ts";
import { displayName, type LocalSession } from "./session-list.ts";
import type { SessionMeta } from "./shared.ts";
import { accent, attention, dim } from "./theme.ts";

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
}

export function buildStatusLine(inp: StatusInputs): string {
  const { meta, stats } = inp;
  const counts = `${stats.running} running, ${stats.waiting} waiting`;
  if (inp.dialog) {
    return accent(dialogPrompt(inp.dialog));
  }
  if (inp.flash) {
    return accent(inp.flash);
  }
  if (inp.switcherOpen) {
    return dim(
      inp.selectedName
        ? `switcher - ${inp.selectedName} - enter open, arrows navigate, / for commands`
        : "switcher - esc or left closes",
    );
  }
  if (!inp.viewing) {
    return dim(`${counts} | left: switcher`);
  }
  const parts = [displayName(meta, inp.info)];
  const shortModel = meta?.model?.split("/").pop();
  if (shortModel && shortModel !== "loading") {
    parts.push(shortModel);
  }
  parts.push(stateLabel(meta));
  if (meta?.tokens) {
    parts.push(`${fmtTokens(meta.tokens)} tok`);
  }
  if (meta?.cost) {
    parts.push(`$${meta.cost.toFixed(2)}`);
  }
  if (meta?.attachedElsewhere) {
    parts.push(attention("VIEW-ONLY"));
  }
  if (meta?.externallyLive) {
    parts.push(attention("LIVE-IN-PI"));
  }
  parts.push(dim(counts));
  parts.push(dim("left: switcher"));
  return parts.join(dim(" | "));
}
