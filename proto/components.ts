// Small adjustments to pi's message components that pi's own options don't
// offer: no ``` fences around code blocks, and air above user messages.
import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";

/** What pi-tui's markdown draws for a fence line; such lines are dropped. */
export const FENCE_MARK = "⁣ronpi-fence⁣";

const ESCAPES = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const isBlank = (line: string): boolean => line.replace(ESCAPES, "").trim() === "";

/**
 * Assistant message without markdown code fences (the code stays indented and colored),
 * and without the blank lines pi leaves around a hidden thinking block: a message with
 * nothing visible takes no space, and leading blanks collapse to one.
 */
export class AssistantMessage extends AssistantMessageComponent {
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
