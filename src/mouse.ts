// Mouse reporting on and off at run time (/mouse). pi-tui turns it on at start with
// these same codes and reads its own `mouseEnabled` flag only at start and stop, so
// writing them is all a toggle needs. While it is off the terminal owns the mouse:
// native select, copy and middle-click paste (also over ssh); toriel's clicks stop.

/** What pi-tui sends at start (button-motion mode, focus reports, SGR coordinates). */
export const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";

/** What pi-tui sends at stop; also clears all-motion mode (1003) in case it was on. */
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

export type MouseChoice = "on" | "off" | "toggle" | "status";

/** The choice a `/mouse` argument names; undefined when it is not one. */
export function parseMouseArg(arg: string): MouseChoice | undefined {
  const a = arg.trim().toLowerCase();
  if (a === "") {
    return "status";
  }
  return a === "on" || a === "off" || a === "toggle" || a === "status" ? a : undefined;
}

/** The state after `choice`, given the state now. */
export function nextMouse(current: boolean, choice: MouseChoice): boolean {
  if (choice === "status") {
    return current;
  }
  return choice === "toggle" ? !current : choice === "on";
}

/** The notice for a /mouse call. */
export function mouseNotice(on: boolean, changed: boolean): string {
  if (on) {
    return changed ? "mouse on - clicks, double-click, selection and wheel are toriel's" : "mouse is on (/mouse off hands it to the terminal)";
  }
  return changed
    ? "mouse off - the terminal handles select, copy and middle-click paste now (/mouse on to restore toriel's mouse)"
    : "mouse is off (/mouse on restores toriel's mouse)";
}
