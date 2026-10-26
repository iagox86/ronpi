// The chat box: pi-tui's Editor plus a key interceptor, and the keybinding
// setup it needs.
import { appendFileSync } from "node:fs";
import { Editor, Key, KeybindingsManager, matchesKey, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

/**
 * Left-arrow that carries no modifiers beyond caps/numlock lock bits: legacy
 * \x1b[D / \x1bOD, kitty/csi-u \x1b[1;<mods>D or \x1b[1;<mods>:<event>D.
 */
export function isPlainLeft(data: string): boolean {
  if (data === "\x1b[D" || data === "\x1bOD") {
    return true;
  }
  const m = /^\x1b\[1;(\d+)(?::(\d+))?D$/.exec(data);
  if (!m) {
    return false;
  }
  if (m[2] === "3") {
    return false; // key release
  }
  const mods = Number.parseInt(m[1], 10) - 1;
  return (mods & ~(64 | 128)) === 0;
}

/**
 * Key setup for the editor. Up/down are handled in InputEditor.handleInput, so
 * pi-tui's always-browse historyPrevious/Next actions stay unbound.
 */
export function configureEditorKeys(): void {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {}));
}

export class InputEditor extends Editor {
  /** Return true to consume the key before the editor sees it. */
  onKey?: (data: string) => boolean;
  debugLog?: string;

  /** Replace the up/down history with `texts` (oldest first). */
  setHistory(texts: string[]): void {
    // Editor keeps history in private fields and only exposes addToHistory.
    const inner = this as unknown as { history: string[]; historyIndex: number };
    inner.history = [];
    inner.historyIndex = -1;
    for (const text of texts) {
      this.addToHistory(text);
    }
  }

  /**
   * Up moves through the text, and from the top line goes to the previous
   * history entry (a typed draft is kept and comes back on down). Down is the
   * stock behavior: through the text, and from the bottom line to the next
   * entry while browsing history.
   */
  private historyOnUp(data: string): boolean {
    if (!matchesKey(data, Key.up) || this.isShowingAutocomplete()) {
      return false;
    }
    const inner = this as unknown as { isOnFirstVisualLine(): boolean; navigateHistory(direction: number): void };
    if (!inner.isOnFirstVisualLine()) {
      return false;
    }
    inner.navigateHistory(-1);
    return true;
  }

  /** Insert text as if it had been pasted by the terminal (large pastes collapse into a marker). */
  pasteText(text: string): void {
    super.handleInput(`\x1b[200~${text}\x1b[201~`);
  }

  handleInput(data: string): void {
    if (this.debugLog) {
      try {
        appendFileSync(this.debugLog, `${JSON.stringify(data)}\n`);
      } catch {
        // debug only
      }
    }
    if (this.onKey?.(data)) {
      return;
    }
    if (this.historyOnUp(data)) {
      return;
    }
    super.handleInput(data);
  }
}
