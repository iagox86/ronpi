// A docked pick-one list for commands with a known set of choices (/model):
// up/down move, typing narrows (every word must appear), enter picks, esc
// cancels. Same popup look as the other panels.
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { matching } from "./completion.ts";
import { accent, dim, panel, panelInnerWidth, selected } from "./theme.ts";

const VISIBLE = 10;

interface Open {
  title: string;
  choices: string[];
  /** Marked with * in the list and highlighted first. */
  current?: string;
  onPick: (choice: string) => void;
  filter: string;
  index: number;
}

export class ChoicePanel implements Component {
  private state: Open | undefined;

  get isOpen(): boolean {
    return this.state !== undefined;
  }

  open(title: string, choices: string[], current: string | undefined, onPick: (choice: string) => void): void {
    this.state = { title, choices, current, onPick, filter: "", index: Math.max(0, current ? choices.indexOf(current) : 0) };
  }

  close(): void {
    this.state = undefined;
  }

  private shown(): string[] {
    return this.state ? matching(this.state.choices, this.state.filter) : [];
  }

  /** Handle a key while open; always consumes it. */
  keys(data: string): boolean {
    const st = this.state;
    if (!st) {
      return false;
    }
    const shown = this.shown();
    if (matchesKey(data, Key.escape)) {
      this.close();
    } else if (matchesKey(data, Key.up)) {
      st.index = Math.max(0, st.index - 1);
    } else if (matchesKey(data, Key.down)) {
      st.index = Math.min(Math.max(0, shown.length - 1), st.index + 1);
    } else if (matchesKey(data, Key.enter)) {
      const choice = shown[st.index];
      if (choice !== undefined) {
        this.close();
        st.onPick(choice);
      }
    } else if (matchesKey(data, Key.backspace)) {
      st.filter = st.filter.slice(0, -1);
      st.index = 0;
    } else if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data) && !data.startsWith("\x1b")) {
      st.filter += data;
      st.index = 0;
    }
    return true;
  }

  render(width: number): string[] {
    const st = this.state;
    if (!st) {
      return [];
    }
    const inner = panelInnerWidth(width);
    const shown = this.shown();
    const index = Math.min(st.index, Math.max(0, shown.length - 1));
    const start = Math.max(0, Math.min(index - Math.floor(VISIBLE / 2), shown.length - VISIBLE));
    const lines = [accent(truncateToWidth(` ${st.title}`, inner)), dim(truncateToWidth(` filter: ${st.filter}█`, inner)), ""];
    if (shown.length === 0) {
      lines.push(dim(" (no matches)"));
    }
    if (start > 0) {
      lines.push(dim(`   ... ${start} more above`));
    }
    shown.slice(start, start + VISIBLE).forEach((choice, i) => {
      const mark = choice === st.current ? "*" : " ";
      const text = truncateToWidth(` ${start + i === index ? ">" : " "} ${mark} ${choice}`, inner);
      lines.push(start + i === index ? selected(text) : dim(text));
    });
    const below = shown.length - (start + VISIBLE);
    if (below > 0) {
      lines.push(dim(`   ... ${below} more below`));
    }
    lines.push("", dim(" up/down choose - enter pick - type to filter - esc cancel"));
    return panel(lines, width);
  }

  invalidate(): void {}
}
