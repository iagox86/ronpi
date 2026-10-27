// Pure: resolve what the user typed after /model to one of pi's available models.

export interface ModelRef {
  provider: string;
  id: string;
}

export type ModelMatch =
  | { kind: "one"; model: ModelRef }
  | { kind: "many"; matches: ModelRef[] }
  | { kind: "none" };

export const modelName = (m: ModelRef): string => `${m.provider}/${m.id}`;

/**
 * An exact "provider/id" (or bare id, if unambiguous) wins; otherwise every
 * whitespace-separated word must appear in "provider/id", case-insensitively.
 */
export function matchModel(models: readonly ModelRef[], query: string): ModelMatch {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return { kind: "none" };
  }
  const exact = models.filter((m) => modelName(m).toLowerCase() === q);
  const byId = models.filter((m) => m.id.toLowerCase() === q);
  const pick = exact.length > 0 ? exact : byId;
  if (pick.length === 1) {
    return { kind: "one", model: pick[0] };
  }
  const words = q.split(/\s+/);
  const matches = models.filter((m) => words.every((w) => modelName(m).toLowerCase().includes(w)));
  if (matches.length === 1) {
    return { kind: "one", model: matches[0] };
  }
  return matches.length === 0 ? { kind: "none" } : { kind: "many", matches };
}
