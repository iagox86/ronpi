// Provider errors arrive as one long string with JSON nested inside JSON
// (a gateway wrapping the upstream's error). This pulls out what a person
// needs: the status, the real message, any remedy, and the gateway's note.

interface Parsed {
  status?: string;
  type?: string;
  message: string;
  hint?: string;
  note?: string;
}

const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

function tryJson(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The JSON object embedded in `text` (first "{" to the last "}"), if it parses. */
function embedded(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? tryJson(text.slice(start, end + 1)) : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Follow `message`/`error` fields down through nested JSON to the innermost message. */
function dig(obj: Record<string, unknown>, out: Parsed): void {
  const err = obj.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : obj;
  out.type ??= str(obj.type) ?? str(err.type);
  const meta = err.metadata && typeof err.metadata === "object" ? (err.metadata as Record<string, unknown>) : {};
  out.hint ??= str(meta.remedy_hint);
  const msg = str(err.message) ?? str(obj.message) ?? (typeof obj.error === "string" ? obj.error : undefined);
  if (!msg) {
    return;
  }
  // the outer message is often "Prefix: {inner json}\n\nGateway note"
  const [head, ...rest] = msg.split(/\n\s*\n/);
  const note = rest.join(" ");
  if (note && !out.note) {
    out.note = flat(note).split(/(?<=\.)\s/)[0];
  }
  const inner = embedded(head);
  if (inner) {
    dig(inner, out);
    return;
  }
  out.message = flat(head);
}

/** Readable form of a provider error string; unparseable text is just whitespace-flattened. */
export function prettyError(raw: string): string {
  const text = raw.trim();
  const m = /^(?:Error:\s*)?(\d{3})\b:?\s*([\s\S]*)$/.exec(text);
  const body = m ? m[2] : text.replace(/^Error:\s*/, "");
  const parsed: Parsed = { status: m?.[1], message: "" };
  const obj = embedded(body);
  if (obj) {
    dig(obj, parsed);
  }
  if (!parsed.message) {
    return flat(text.replace(/^Error:\s*/, ""));
  }
  const label = [parsed.status, parsed.type].filter(Boolean).join(" ");
  const lines = [label ? `${label}: ${parsed.message}` : parsed.message];
  if (parsed.hint) {
    lines.push(flat(parsed.hint));
  }
  if (parsed.note) {
    lines.push(parsed.note);
  }
  return lines.join("\n");
}
