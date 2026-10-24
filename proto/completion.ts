// Helpers for argument completion (see CommandSpec.complete).

/**
 * The choices whose text contains every word typed so far, case-insensitively.
 * Typing flags (a word starting with "-") ends completion: it is for values.
 */
export function matching(choices: readonly string[], typed: string): string[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.some((w) => w.startsWith("-"))) {
    return [];
  }
  return choices.filter((c) => words.every((w) => c.toLowerCase().includes(w)));
}
