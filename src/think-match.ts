// Pure: resolve what the user typed after /think to one of the model's
// thinking levels (pi reports the list over RPC; it varies per model).

export type LevelMatch<L extends string = string> =
  | { kind: "one"; level: L }
  | { kind: "many"; matches: L[] }
  | { kind: "none" };

/**
 * An exact level wins; otherwise every level the query is a prefix of matches,
 * case-insensitively.
 */
export function matchThinkingLevel<L extends string>(levels: readonly L[], query: string): LevelMatch<L> {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return { kind: "none" };
  }
  const exact = levels.find((l) => l.toLowerCase() === q);
  if (exact !== undefined) {
    return { kind: "one", level: exact };
  }
  const matches = levels.filter((l) => l.toLowerCase().startsWith(q));
  if (matches.length === 1) {
    return { kind: "one", level: matches[0] };
  }
  return matches.length === 0 ? { kind: "none" } : { kind: "many", matches };
}
