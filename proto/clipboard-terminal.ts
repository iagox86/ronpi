// A terminal that notices middle-button presses before the TUI does. pi-tui
// turns every mouse report into its own selection and scrolling handling and
// has no hook for a middle click, which on Linux means "paste what is
// highlighted" - so the click is taken out of the input stream here.
import { ProcessTerminal } from "@earendil-works/pi-tui";

const SGR_MOUSE = /^\x1b\[<(\d+);\d+;\d+([Mm])$/;

/** "press" or "release" when `data` is a middle-button report (SGR mouse mode), else undefined. */
export function middleButton(data: string): "press" | "release" | undefined {
  const m = SGR_MOUSE.exec(data);
  if (!m) {
    return undefined;
  }
  const code = Number(m[1]);
  const wheel = (code & 64) !== 0;
  const motion = (code & 32) !== 0;
  if (wheel || motion || (code & 3) !== 1) {
    return undefined;
  }
  return m[2] === "M" ? "press" : "release";
}

export class ClipboardTerminal extends ProcessTerminal {
  private readonly onMiddlePress: () => boolean;
  /** A press was taken, so its release is too. */
  private swallowing = false;

  /** `onMiddlePress` returns whether it handled the click; if not, the click goes on to the TUI untouched. */
  constructor(onMiddlePress: () => boolean) {
    super();
    this.onMiddlePress = onMiddlePress;
  }

  override start(onInput: (data: string) => void, onResize: () => void): void {
    super.start((data) => {
      const middle = middleButton(data);
      if (middle === "press") {
        this.swallowing = this.onMiddlePress();
        if (this.swallowing) {
          return;
        }
      } else if (middle === "release" && this.swallowing) {
        this.swallowing = false;
        return;
      }
      onInput(data);
    }, onResize);
  }
}
