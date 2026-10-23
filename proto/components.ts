// Small adjustments to pi's message components that pi's own options don't
// offer: no ``` fences around code blocks, and air above user messages.
import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";

/** What pi-tui's markdown draws for a fence line; such lines are dropped. */
export const FENCE_MARK = "⁣ronpi-fence⁣";

/** Assistant message without markdown code fences (the code stays indented and colored). */
export class AssistantMessage extends AssistantMessageComponent {
  override render(width: number): string[] {
    return super.render(width).filter((line) => !line.includes(FENCE_MARK));
  }
}

/** User message with a blank line above, so it doesn't butt against the previous output. */
export class UserMessage extends UserMessageComponent {
  override render(width: number): string[] {
    return ["", ...super.render(width)];
  }
}
