// The switcher's temporary filter: which rows to show.
import type { SwitcherSession } from "./switcher.ts";

export interface Filter {
  /** The query as typed. */
  text: string;
  regex: boolean;
  test(s: SwitcherSession): boolean;
  /** Whether a group's own name matches (so an empty group can still be found). */
  testGroup(name: string): boolean;
}

/** What a query is matched against: everything the row shows, plus its directory and comment. */
function haystack(s: SwitcherSession): string {
  return [s.name, s.description, s.group, s.model, s.cwd, s.note, s.comment].filter(Boolean).join(" ");
}

/**
 * Plain: every word must appear, case-insensitively. Regex: the whole query is
 * one case-insensitive pattern. Throws on an invalid pattern; an empty query
 * is no filter (null).
 */
export function compileFilter(text: string, regex: boolean): Filter | null {
  const query = text.trim();
  if (!query) {
    return null;
  }
  if (regex) {
    const re = new RegExp(query, "i");
    return { text: query, regex, test: (s) => re.test(haystack(s)), testGroup: (name) => re.test(name) };
  }
  const words = query.toLowerCase().split(/\s+/);
  const hasAll = (text: string) => {
    const hay = text.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  return { text: query, regex, test: (s) => hasAll(haystack(s)), testGroup: hasAll };
}
