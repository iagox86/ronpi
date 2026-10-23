// The message list behind double-Esc: a short docked list of earlier user
// messages, newest at the bottom, the selection starting on the newest.
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { oneLineFlat } from "./format.ts";
import type { RewindTarget } from "./rewind.ts";
import { dim, selected } from "./theme.ts";

const VISIBLE = 8;

export function pickerLines(targets: RewindTarget[], index: number, width: number): string[] {
  const lines = [dim(truncateToWidth(" Rewind to before which message? Conversation only - file changes are not undone.", width))];
  const start = Math.max(0, Math.min(index - Math.floor(VISIBLE / 2), targets.length - VISIBLE));
  const shown = targets.slice(start, start + VISIBLE);
  if (start > 0) {
    lines.push(dim(`   ... ${start} earlier`));
  }
  shown.forEach((t, i) => {
    const text = oneLineFlat(t.text, Math.max(10, width - 6)) || "(empty message)";
    lines.push(truncateToWidth(start + i === index ? selected(` > ${text}`) : dim(`   ${text}`), width));
  });
  lines.push(dim(" up/down choose - enter rewind - esc cancel"));
  return lines;
}

export class RewindPicker implements Component {
  private targets: RewindTarget[] = [];
  private index = 0;

  get isOpen(): boolean {
    return this.targets.length > 0;
  }

  open(targets: RewindTarget[]): void {
    this.targets = targets;
    this.index = targets.length - 1;
  }

  close(): void {
    this.targets = [];
  }

  move(delta: number): void {
    this.index = Math.max(0, Math.min(this.targets.length - 1, this.index + delta));
  }

  current(): RewindTarget | undefined {
    return this.targets[this.index];
  }

  render(width: number): string[] {
    return this.isOpen ? pickerLines(this.targets, this.index, width) : [];
  }

  invalidate(): void {}
}
