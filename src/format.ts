// Small text helpers shared by the controller and the switcher.

/** Compact age: 30s, 5m, 2h, 3d. */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h`;
  }
  return `${Math.floor(h / 24)}d`;
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1)}k`;
  }
  return String(Math.round(n));
}

/** Collapse runs of whitespace (including newlines) to single spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Collapse whitespace; truncate with "..." beyond width. */
export function oneLineFlat(text: string, width: number): string {
  const flat = oneLine(text);
  return flat.length > width ? `${flat.slice(0, width - 1)}...` : flat;
}

/** Tail of a long text blob, for "last activity" columns. */
export function lastLine(text: string, width = 90): string {
  const flat = oneLineFlat(text, Number.MAX_SAFE_INTEGER);
  return flat.length > width ? `...${flat.slice(-width)}` : flat;
}

/** Plain text of a message whose content is a string or content blocks. */
export function messageText(m: { content?: unknown }): string {
  if (typeof m.content === "string") {
    return m.content;
  }
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => (b as { type?: string }).type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n");
  }
  return "";
}
