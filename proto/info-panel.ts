// A docked, dismissable text panel for multi-line command output (--help,
// /help). Shares the popup look of the dialog and rewind panels.
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { dim, panel, panelInnerWidth } from "./theme.ts";

export class InfoPanel implements Component {
  private lines: string[] = [];

  get isOpen(): boolean {
    return this.lines.length > 0;
  }

  show(text: string): void {
    this.lines = text.split("\n");
  }

  close(): void {
    this.lines = [];
  }

  render(width: number): string[] {
    if (!this.isOpen) {
      return [];
    }
    const inner = panelInnerWidth(width);
    const body = this.lines.map((l) => truncateToWidth(` ${l}`, inner));
    return panel([...body, "", dim(" esc or enter closes")], width);
  }

  invalidate(): void {}
}
