// /command (and, in a session, @file / path) completion for the chat box. The
// provider asks `source` what applies at every keystroke, so the switcher/
// session context switch and newly registered commands need no re-wiring.
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { SESSION_COMMANDS, SWITCHER_COMMANDS, type CommandSpec } from "./commands.ts";

export interface AutocompleteContext {
  /** Switcher box: only ronpi's commands, no file completion. */
  switcher: boolean;
  /** Commands pi reported for the viewed session. */
  piCommands: ReadonlyArray<{ name: string; description?: string }>;
  cwd: string;
}

/** The slash commands that apply in `ctx`; ronpi's own win a name clash with pi's. */
export function commandsFor(ctx: AutocompleteContext): SlashCommand[] {
  const own: readonly CommandSpec[] = ctx.switcher ? SWITCHER_COMMANDS : SESSION_COMMANDS;
  const taken = new Set(own.map((c) => c.name));
  return [
    ...own.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
    ...(ctx.switcher ? [] : ctx.piCommands.filter((c) => !taken.has(c.name))),
  ];
}

export class CommandAutocomplete implements AutocompleteProvider {
  private readonly source: () => AutocompleteContext;

  constructor(source: () => AutocompleteContext) {
    this.source = source;
  }

  private delegate(): { ctx: AutocompleteContext; provider: CombinedAutocompleteProvider } {
    const ctx = this.source();
    return { ctx, provider: new CombinedAutocompleteProvider(commandsFor(ctx), ctx.cwd, null) };
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const { ctx, provider } = this.delegate();
    if (ctx.switcher && !(cursorLine === 0 && (lines[0] ?? "").startsWith("/"))) {
      return null;
    }
    return provider.getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
    return this.delegate().provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const { ctx, provider } = this.delegate();
    return !ctx.switcher && provider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}
