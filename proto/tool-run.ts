// A run of consecutive tool calls. Collapsed (the default) it is one summary
// line; expanded it is pi's full block for every call. Tool output and diffs
// are large, so the transcript stays readable until the user asks for them.
import type { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { attention, dim } from "./theme.ts";

export interface ToolCall {
  name: string;
  component: ToolExecutionComponent;
  failed: boolean;
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
      return this.calls.flatMap((c) => {
        c.component.setExpanded(true); // pi truncates long output until expanded
        return c.component.render(width);
      });
    }
    return [truncateToWidth(summaryLine(this.calls, this.showHint), width)];
  }

  invalidate(): void {
    for (const c of this.calls) {
      c.component.invalidate();
    }
  }
}
