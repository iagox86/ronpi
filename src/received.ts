// A message one session sends another arrives as an ordinary user message (pi's
// RPC takes nothing else) that begins with a fixed label. This module writes and
// reads that label so the UI can show it as "from X" and keep it out of rewind.
const LABEL = /^\[from (.+?) \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\]: ([\s\S]*)$/i;

export interface Received {
  fromName: string;
  fromId: string;
  text: string;
}

export function formatReceived(fromName: string, fromId: string, text: string): string {
  return `[from ${fromName.replace(/[\r\n]+/g, " ")} (${fromId})]: ${text}`;
}

/** What to show for a user message: a received one as "◂ from NAME" over its body, anything else unchanged. */
export function displayText(text: string): string {
  const r = parseReceived(text);
  return r ? `\u25c2 from ${r.fromName} (${r.fromId.slice(0, 8)})\n${r.text}` : text;
}

/** The sender and body of a message written by `formatReceived`, or undefined for anything else. */
export function parseReceived(text: string): Received | undefined {
  const m = LABEL.exec(text);
  return m ? { fromName: m[1] as string, fromId: m[2] as string, text: m[3] as string } : undefined;
}
