// Small adjustments to pi's message components that pi's own options don't
// offer: no ``` fences around code blocks, and air above user messages.
import { AssistantMessageComponent, CompactionSummaryMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { prettyError } from "./error-format.ts";

/** What pi-tui's markdown draws for a fence line; such lines are dropped. */
export const FENCE_MARK = "⁣toriel-fence⁣";

const ESCAPES = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const isBlank = (line: string): boolean => line.replace(ESCAPES, "").trim() === "";

/**
 * Assistant message without markdown code fences (the code stays indented and colored),
 * and without the blank lines pi leaves around a hidden thinking block: a message with
 * nothing visible takes no space, and leading blanks collapse to one.
 */
export class AssistantMessage extends AssistantMessageComponent {
  // `declare`: pi's constructor already calls updateContent, and an initialized field would reset what it stored
  declare private lastArgs?: [Parameters<AssistantMessageComponent["updateContent"]>[0], ...unknown[]];
  private showRawError = false;

  override updateContent(message: Parameters<AssistantMessageComponent["updateContent"]>[0], ...rest: unknown[]): void {
    this.lastArgs = [message, ...rest];
    const failed = message.stopReason === "error" && message.errorMessage;
    const shown = failed && !this.showRawError ? { ...message, errorMessage: prettyError(message.errorMessage as string) } : message;
    (super.updateContent as (...a: unknown[]) => void)(shown, ...rest);
  }

  /** Show the provider's original error text instead of the tidied one. */
  setShowRawError(on: boolean): void {
    if (on !== this.showRawError && this.lastArgs) {
      this.showRawError = on;
      this.updateContent(...this.lastArgs);
    } else {
      this.showRawError = on;
    }
  }

  override render(width: number): string[] {
    const lines = super.render(width).filter((line) => !line.includes(FENCE_MARK));
    const firstText = lines.findIndex((line) => !isBlank(line));
    if (firstText === -1) {
      return [];
    }
    return firstText > 1 ? lines.slice(firstText - 1) : lines;
  }
}

/** User message with a blank line above, so it doesn't butt against the previous output. */
export class UserMessage extends UserMessageComponent {
  override render(width: number): string[] {
    return ["", ...super.render(width)];
  }
}

/** Renders `inner` faint, for conversation the model no longer has. */
export class Dimmed implements Component {
  private readonly inner: Component;
  private cached?: { width: number; lines: string[] };

  constructor(inner: Component) {
    this.inner = inner;
  }

  render(width: number): string[] {
    if (this.cached?.width === width) {
      return this.cached.lines;
    }
    // resets inside the content would end the faint attribute; re-arm after each
    const lines = this.inner
      .render(width)
      .map((l) => `\x1b[2m${l.replaceAll("\x1b[0m", "\x1b[0m\x1b[2m").replaceAll("\x1b[22m", "\x1b[22m\x1b[2m")}\x1b[22m`);
    this.cached = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.cached = undefined;
    this.inner.invalidate();
  }
}

/**
 * pi's compaction row, with its expand hint filled in: pi looks the key up in
 * its own app keybindings, which toriel does not load, so the hint comes out as
 * "( to expand)". Our toggle for it is ctrl-o.
 */
export class CompactionRow extends CompactionSummaryMessageComponent {
  override render(width: number): string[] {
    return super.render(width).map((l) => l.replace(/\(((?:\x1b\[[0-9;]*m)*) to expand\)/, "($1ctrl-o to expand)"));
  }
}
