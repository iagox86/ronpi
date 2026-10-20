// Solarized-dark palette, 256-color approximations. Chrome styles use scoped
// resets (22/39) so they compose with the switcher's background padding.
export const bg = "\x1b[48;5;234m";

/** base01 - captions, descriptions, quiet chrome. */
export const dim = (s: string) => `\x1b[38;5;245m${s}\x1b[22m`;
/** cyan - selection, interactive hints. */
export const accent = (s: string) => `\x1b[38;5;37m${s}\x1b[39m`;
/** bold cyan - the selected switcher row. */
export const selected = (s: string) => `\x1b[1m\x1b[38;5;37m${s}\x1b[39m\x1b[22m`;
/** yellow - streaming/working markers. */
export const streaming = (s: string) => `\x1b[38;5;136m${s}\x1b[39m`;
/** orange - attention (waiting on permission, errors). */
export const attention = (s: string) => `\x1b[38;5;166m${s}\x1b[39m`;
