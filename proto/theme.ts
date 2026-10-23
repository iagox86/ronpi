// All colors come from the pi theme file (pi/themes/<THEME_NAME>.json),
// the same file pi's own components render with, so the switcher, session
// view and chrome cannot drift apart. Add new UI colors by pointing at an
// existing theme token (or a var), never by hardcoding an escape sequence.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const THEME_NAME = "solarized-dark";
// The repo pi/ dir doubles as a fake agent dir (it has themes/), see pi-theme.ts.
export const AGENT_DIR = join(import.meta.dirname, "..", "pi");

interface ThemeFile {
  vars: Record<string, string>;
  colors: Record<string, string>;
  export: { pageBg: string };
}

const file: ThemeFile = JSON.parse(readFileSync(join(AGENT_DIR, "themes", `${THEME_NAME}.json`), "utf8"));

function hex(ref: string): [number, number, number] {
  const value = file.vars[ref] ?? ref;
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!m) {
    throw new Error(`theme ${THEME_NAME}: "${ref}" is not a #rrggbb color`);
  }
  return [parseInt(m[1] as string, 16), parseInt(m[2] as string, 16), parseInt(m[3] as string, 16)];
}

const rgb = (ref: string) => hex(ref).join(";");
const token = (name: string): string => {
  const ref = file.colors[name];
  if (!ref) {
    throw new Error(`theme ${THEME_NAME}: no color token "${name}"`);
  }
  return ref;
};

/** The page background; the switcher paints it explicitly. */
export const bg = `\x1b[48;2;${rgb(file.export.pageBg)}m`;

// Chrome styles use scoped resets (22/39) so they compose with the switcher's
// background padding.
const fg = (name: string) => `\x1b[38;2;${rgb(token(name))}m`;
const dimFg = fg("muted");
const accentFg = fg("accent");
const warningFg = fg("warning");
const errorFg = fg("error");
const brightFg = fg("toolTitle");

/** muted - captions, descriptions, quiet chrome. */
export const dim = (s: string) => `${dimFg}${s}\x1b[39m`;
/** accent - selection, interactive hints. */
export const accent = (s: string) => `${accentFg}${s}\x1b[39m`;
/** bold accent - the selected switcher row. */
export const selected = (s: string) => `\x1b[1m${accentFg}${s}\x1b[39m\x1b[22m`;
/** warning - streaming/working markers. */
export const streaming = (s: string) => `${warningFg}${s}\x1b[39m`;
/** error - attention (waiting on permission, errors). */
export const attention = (s: string) => `${errorFg}${s}\x1b[39m`;
/** accent - the working spinner glyph. */
export const spinner = accent;
/** muted italic - messages sent but not yet processed by the agent. */
export const queued = (s: string) => `\x1b[3m${dimFg}${s}\x1b[39m\x1b[23m`;
/** bold bright - column headers. */
export const header = (s: string) => `\x1b[1m${brightFg}${s}\x1b[0m`;
/** bright - group titles. */
export const groupTitle = (s: string) => `${brightFg}${s}\x1b[0m`;

/** The UI is built for 24-bit color; refuse to run garbled on anything less. */
export function assertTruecolor(env: NodeJS.ProcessEnv = process.env): void {
  const ct = env.COLORTERM;
  if (ct !== "truecolor" && ct !== "24bit") {
    throw new Error(
      "ronpi needs a 24-bit color terminal (COLORTERM=truecolor or 24bit); " +
        `COLORTERM is ${ct ? `"${ct}"` : "unset"}. Set it if your terminal does support truecolor.`,
    );
  }
}
