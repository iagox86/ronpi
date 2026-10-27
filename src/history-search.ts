// ctrl-r reverse search over the editor's history: a prompt
// like readline's, shown in the input box itself. Typing narrows the match, ctrl-r steps to the next older
// one, enter accepts it into the editor, esc cancels and leaves the editor alone.
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { oneLineFlat } from "./format.ts";

export type SearchResult = "none" | "accept" | "cancel";

export class HistorySearch {
  private texts: string[] = [];
  private query = "";
  private hit = -1;
  private active = false;

  get isOpen(): boolean {
    return this.active;
  }

  /** `history` is oldest first, as the editor wants it; duplicates collapse to the newest. */
  open(history: string[]): void {
    const seen = new Set<string>();
    this.texts = [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (!seen.has(history[i] as string)) {
        seen.add(history[i] as string);
        this.texts.push(history[i] as string);
      }
    }
    this.query = "";
    this.hit = this.texts.length > 0 ? 0 : -1;
    this.active = true;
  }

  close(): void {
    this.active = false;
  }

  /** The text enter would accept, if anything matches. */
  current(): string | undefined {
    return this.hit === -1 ? undefined : this.texts[this.hit];
  }

  /** Newest-first index of the first match at or after `from`; -1 when none. */
  private find(from: number): number {
    const needle = this.query.toLowerCase();
    for (let i = from; i < this.texts.length; i++) {
      if ((this.texts[i] as string).toLowerCase().includes(needle)) {
        return i;
      }
    }
    return -1;
  }

  /** Feed a key; returns whether the search finished (accept) or was abandoned (cancel). */
  handleKey(data: string): SearchResult {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("g"))) {
      return "cancel";
    }
    if (matchesKey(data, Key.enter)) {
      return this.current() === undefined ? "cancel" : "accept";
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      const next = this.find(this.hit + 1);
      this.hit = next === -1 ? this.hit : next;
      return "none";
    }
    if (matchesKey(data, Key.ctrl("s"))) {
      // toward newer matches
      const needle = this.query.toLowerCase();
      for (let i = this.hit - 1; i >= 0; i--) {
        if ((this.texts[i] as string).toLowerCase().includes(needle)) {
          this.hit = i;
          break;
        }
      }
      return "none";
    }
    if (matchesKey(data, Key.backspace)) {
      this.query = this.query.slice(0, -1);
      this.hit = this.find(0);
      return "none";
    }
    // printable text (typed or pasted); control sequences are ignored
    if (data.length > 0 && !data.includes("\x1b") && !/[\x00-\x1f\x7f]/.test(data)) {
      this.query += data;
      this.hit = this.find(0);
    }
    return "none";
  }

  /** What the input box shows while searching, readline style. */
  promptText(): string {
    const found = this.current();
    const label = this.hit === -1 && this.query ? "failed reverse-search" : "reverse-search";
    return `(${label}) ${this.query}: ${found === undefined ? "" : oneLineFlat(found, 500)}`;
  }
}
