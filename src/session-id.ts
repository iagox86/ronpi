// Naming sessions: stable ids (pi's session UUID) are the address, names are a
// convenience. `resolveSession` turns whatever a person or agent typed into one
// session; `uniqueName` keeps names from colliding.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The shortest UUID prefix accepted as an address. */
export const MIN_PREFIX = 8;

export const isUuid = (s: string): boolean => UUID.test(s);

export interface Addressable {
  /** Daemon-assigned number, valid for this daemon run. */
  id: number;
  sessionId?: string;
  sessionName?: string;
}

export type Resolution<T> = { kind: "found"; session: T } | { kind: "none" } | { kind: "ambiguous"; matches: T[] };

/**
 * One session from a UUID, a UUID prefix (at least 8 characters), a daemon
 * number written `#12`, or a name (case-insensitive, exact). The first rule
 * that matches anything decides; several matches under that rule are ambiguous
 * rather than guessed.
 */
export function resolveSession<T extends Addressable>(query: string, sessions: readonly T[]): Resolution<T> {
  const q = query.trim();
  const rules: Array<(s: T) => boolean> = [];
  const lower = q.toLowerCase();
  if (isUuid(q)) {
    rules.push((s) => s.sessionId?.toLowerCase() === lower);
  }
  if (/^[0-9a-f-]+$/i.test(q) && q.length >= MIN_PREFIX) {
    rules.push((s) => s.sessionId?.toLowerCase().startsWith(lower) === true);
  }
  const num = /^#(\d+)$/.exec(q);
  if (num) {
    rules.push((s) => s.id === Number(num[1]));
  }
  rules.push((s) => s.sessionName?.toLowerCase() === lower);
  for (const rule of rules) {
    const matches = sessions.filter(rule);
    if (matches.length === 1) {
      return { kind: "found", session: matches[0] as T };
    }
    if (matches.length > 1) {
      return { kind: "ambiguous", matches };
    }
  }
  return { kind: "none" };
}

/** `wanted`, or `wanted #2`, `#3`... when another session already has that name (case-insensitive). */
export function uniqueName(wanted: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((n) => n.toLowerCase()));
  if (!names.has(wanted.toLowerCase())) {
    return wanted;
  }
  const base = wanted.replace(/ #\d+$/, "");
  for (let n = 2; ; n++) {
    const candidate = `${base} #${n}`;
    if (!names.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}
