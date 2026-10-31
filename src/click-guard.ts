// pi-tui turns a plain click (press and release on one cell) into a "click"
// for the component under it, and pi's thinking blocks and tool output toggle
// on that. Clicking the transcript to drop a text selection or to focus the
// window then opened and closed blocks at random, so by default only a
// double click is passed on to the transcript.
import type { TuiAltScreen } from "@earendil-works/pi-tui";

type ClickEvent = { type: string; clickCount?: number };

/** Whether a mouse event may reach the transcript components; `single` passes every click. */
export function passesToTranscript(event: ClickEvent, mode: "double" | "single" = clickMode()): boolean {
  if (event.type !== "click" || mode === "single") {
    return true;
  }
  return (event.clickCount ?? 1) >= 2;
}

/** `TORIEL_CLICK=single` brings back pi's one-click toggle. */
export function clickMode(env: NodeJS.ProcessEnv = process.env): "double" | "single" {
  return env.TORIEL_CLICK === "single" ? "single" : "double";
}

/** Wraps the screen's layout dispatch (private in pi-tui, and the one place clicks reach the transcript). */
export function guardClicks<T extends TuiAltScreen>(tui: T): T {
  const screen = tui as unknown as { dispatchMouseToLayout: (event: ClickEvent) => unknown };
  const original = screen.dispatchMouseToLayout.bind(tui);
  screen.dispatchMouseToLayout = (event) => (passesToTranscript(event) ? original(event) : undefined);
  return tui;
}
