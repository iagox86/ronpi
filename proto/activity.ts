// What the viewed session is doing right now ("thinking", "running bash", ...)
// and which messages are queued but not yet processed. The reducer folds pi's
// events into two fields on the view; ActivityLine renders them.
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { queued, spinner, dim } from "./theme.ts";

export interface Activity {
  /** What the agent is doing, e.g. "thinking". */
  label: string;
  /** When the current run started (ms), for the elapsed timer. */
  since: number;
}

export interface ActivityState {
  activity?: Activity;
  /** Messages sent while a run was in flight, in delivery order. */
  queue: string[];
}

/** Update `state` from one live pi event; `now` is injected for tests. */
export function reduceActivity(state: ActivityState, ev: Record<string, unknown>, now: number): void {
  const set = (label: string) => {
    state.activity = { label, since: state.activity?.since ?? now };
  };
  switch (ev.type as string) {
    case "agent_start":
      set("working");
      break;
    case "agent_settled":
      state.activity = undefined;
      break;
    case "message_update": {
      const kind = String((ev.assistantMessageEvent as { type?: string } | undefined)?.type ?? "");
      if (kind.startsWith("thinking")) {
        set("thinking");
      } else if (kind.startsWith("text")) {
        set("writing");
      } else if (kind.startsWith("toolcall")) {
        set("calling a tool");
      }
      break;
    }
    case "tool_execution_start":
      set(`running ${String(ev.toolName ?? "tool")}`);
      break;
    case "tool_execution_end":
    case "compaction_end":
    case "auto_retry_end":
      set("working");
      break;
    case "compaction_start":
      set("compacting context");
      break;
    case "auto_retry_start":
      set(`retrying (${ev.attempt}/${ev.maxAttempts}) in ${Math.round(Number(ev.delayMs ?? 0) / 1000)}s`);
      break;
    case "queue_update":
      state.queue = [...((ev.steering as string[]) ?? []), ...((ev.followUp as string[]) ?? [])];
      break;
  }
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(now: number): string {
  return FRAMES[Math.floor(now / 100) % FRAMES.length] as string;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const MAX_QUEUED_LINES = 3;

/** Lines for the strip under the transcript: queued messages, then the spinner. */
export function activityLines(state: ActivityState, width: number, now: number): string[] {
  const lines: string[] = [];
  const shown = state.queue.slice(0, MAX_QUEUED_LINES);
  for (const text of shown) {
    lines.push(truncateToWidth(queued(`  queued: ${text.replace(/\s+/g, " ")}`), width));
  }
  if (state.queue.length > shown.length) {
    lines.push(queued(`  queued: +${state.queue.length - shown.length} more`));
  }
  if (state.activity) {
    const { label, since } = state.activity;
    lines.push(truncateToWidth(` ${spinner(spinnerFrame(now))} ${label} ${dim(formatElapsed(now - since))}`, width));
  }
  return lines;
}

export class ActivityLine implements Component {
  state: ActivityState = { queue: [] };

  render(width: number): string[] {
    return activityLines(this.state, width, Date.now());
  }

  invalidate(): void {}
}
