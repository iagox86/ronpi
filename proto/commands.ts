// Command registries: the one place a /command is declared. Both the
// dispatch tables and autocomplete are built from these, so a command that is
// added here (and typechecks against its handler table) completes
// automatically.

export interface CommandSpec {
  name: string;
  description: string;
  argumentHint?: string;
}

/** Switcher command box. SwitcherActions must handle every name listed here. */
export const SWITCHER_COMMANDS = [
  { name: "new", description: "start a new session" },
  { name: "kill", description: "deactivate (live) or trash (inactive) the highlighted session" },
  { name: "rename", description: "rename the highlighted session", argumentHint: "<name>" },
  { name: "group", description: "move the highlighted session to a group", argumentHint: "<group>" },
  { name: "adopt", description: "fork an external session into ronpi" },
  { name: "restore", description: "restore from trash (not built yet)" },
  { name: "kill-daemon", description: "stop the daemon and every session it owns" },
  { name: "help", description: "list commands" },
  { name: "exit", description: "leave ronpi (sessions keep running)" },
  { name: "quit", description: "leave ronpi (sessions keep running)" },
] as const satisfies readonly CommandSpec[];

export type SwitcherCommandName = (typeof SWITCHER_COMMANDS)[number]["name"];

/** Handled by ronpi inside a session; everything else goes to pi. */
export const SESSION_COMMANDS = [
  { name: "exit", description: "leave ronpi (sessions keep running)" },
  { name: "quit", description: "back to the session list" },
  { name: "abort", description: "interrupt the running agent" },
] as const satisfies readonly CommandSpec[];

export type SessionCommandName = (typeof SESSION_COMMANDS)[number]["name"];

// Switcher command-box parsing: "/rename new name" -> {name: "rename", arg: "new name"}.
export function parseCommand(cmd: string): { name: string; arg: string } {
  const [name, ...rest] = cmd.slice(1).split(/\s+/);
  return { name: name.toLowerCase(), arg: rest.join(" ").trim() };
}

/** "/new /kill /rename <name> ..." for the /help hint. */
export function helpText(commands: readonly CommandSpec[]): string {
  return commands.map((c) => (c.argumentHint ? `/${c.name} ${c.argumentHint}` : `/${c.name}`)).join(" ");
}
