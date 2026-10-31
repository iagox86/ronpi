// Copying through the terminal itself (OSC 52) when there is no clipboard tool:
// over SSH, or in a terminal with no display. The terminal never says whether it
// accepted the sequence, so a copy this way is "sent", not "copied" (see `osc52Result`).

/**
 * The OSC 52 sequence that sets one selection: `c` is the clipboard (ctrl-v), `p` the
 * primary selection (middle click). They go as two sequences, not one "cp", so a
 * terminal that rejects `p` still keeps the clipboard copy.
 */
export function osc52(text: string, selection: "c" | "p" = "c"): string {
  return `\x1b]52;${selection};${Buffer.from(text).toString("base64")}\x07`;
}

/** tmux's passthrough wrapper: the inner ESCs are doubled; tmux (allow-passthrough on) forwards it to the outer terminal. */
export function tmuxPassthrough(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/**
 * What to write to the terminal. Under tmux, send the plain sequence too: with
 * `set-clipboard on` tmux handles it itself, with `allow-passthrough on` the wrapped
 * copy reaches the outer terminal. Whichever the user has configured works; the
 * other is ignored.
 */
export function osc52Output(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const plain = osc52(text) + osc52(text, "p");
  return env.TMUX ? plain + tmuxPassthrough(plain) : plain;
}

/** The flash text: honest that the terminal's acceptance is unknown, with the likely fix under tmux. */
export function osc52Result(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TMUX) {
    return "Sent to the terminal clipboard (not confirmed) - in tmux needs set-clipboard on or allow-passthrough on";
  }
  return "Sent to the terminal clipboard (not confirmed)";
}
