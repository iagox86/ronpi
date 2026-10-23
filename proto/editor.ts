// The chat box: pi-tui's Editor plus a key interceptor, and the keybinding
// setup it needs.
import { appendFileSync } from "node:fs";
import { Editor, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

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
 * The Editor's history navigation has no default bindings - bind up/down.
 * navigateHistory falls through to cursor movement unless the editor is
 * empty or the cursor is on its first/last visual line.
 */
export function configureEditorKeys(): void {
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.editor.historyPrevious": ["up"],
      "tui.editor.historyNext": ["down"],
    }),
  );
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
    super.handleInput(data);
  }
}
