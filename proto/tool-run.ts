// A run of consecutive tool calls. Collapsed (the default) it is one summary
// line; expanded it is pi's full block for every call. Tool output and diffs
// are large, so the transcript stays readable until the user asks for them.
import type { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { attention, dim } from "./theme.ts";

export interface ToolCall {
  name: string;
  /** The call's arguments as last seen, for displaying its result. */
  args?: unknown;
  component: ToolExecutionComponent;
  failed: boolean;
  /** Finished: its output no longer changes, so rendered lines can be reused. */
  done?: boolean;
  /** Rendered lines of a finished call, valid for `cachedWidth` until invalidate(). */
  cachedLines?: string[];
  cachedWidth?: number;
}

/** "bash x2, read" - names in first-seen order with counts. */
export function toolNames(calls: ToolCall[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) {
    counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(", ");
}

export function summaryLine(calls: ToolCall[], hint = true): string {
  const failed = calls.filter((c) => c.failed).length;
  const noun = calls.length === 1 ? "tool call" : "tool calls";
  const fail = failed > 0 ? ` ${attention(`(${failed} failed)`)}` : "";
  return dim(` > ${calls.length} ${noun}: ${toolNames(calls)}`) + fail + (hint ? dim("  ctrl-o to expand") : "");
}

export class ToolRun implements Component {
  calls: ToolCall[] = [];
  expanded = false;
  /** Whether the collapsed line mentions ctrl-o (only the latest run does). */
  showHint = true;

  render(width: number): string[] {
    if (this.expanded) {
      // pi's tool components do not cache, and the scroll view renders the whole chat every frame
      return this.calls.flatMap((c) => {
        if (c.done && c.cachedWidth === width && c.cachedLines) {
          return c.cachedLines;
        }
        c.component.setExpanded(true); // pi truncates long output until expanded
        const lines = c.component.render(width);
        if (c.done) {
          c.cachedLines = lines;
          c.cachedWidth = width;
        }
        return lines;
      });
    }
    // blank line above, so the summary doesn't hug the text before it
    return ["", truncateToWidth(summaryLine(this.calls, this.showHint), width)];
  }

  invalidate(): void {
    for (const c of this.calls) {
      c.cachedLines = undefined;
      c.component.invalidate();
    }
  }
}
