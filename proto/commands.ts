// Command registries: the one place a /command is declared. A command is a
// name, a description and (optionally) a `build` that declares its options and
// arguments on a commander Command (see cli.ts); parsing, -h/--help and
// autocomplete hints all derive from that. A handler table keyed by name
// (`Record<SwitcherCommandName, ...>` in switcher-actions.ts, likewise in
// session-commands.ts) makes the compiler insist that every command here has
// a handler, so adding one is: an entry here, plus a function there.
import type { Command } from "commander";
import type { CommandSpec } from "./cli.ts";

export type { CommandSpec };

const nameArgument = (verb: string) => (cmd: Command) => {
  cmd.argument("[name...]", `new name (leave out to ${verb})`);
};

/** Switcher command box. SwitcherActions must handle every name listed here. */
export const SWITCHER_COMMANDS = [
  { name: "new", description: "start a new session" },
  { name: "stop", description: "stop the highlighted session's process (file kept; respawns on next prompt)" },
  { name: "delete", description: "move the highlighted session to trash (asks twice; stops it if running)" },
  { name: "rename", description: "rename the highlighted session", build: nameArgument("edit the current name") },
  {
    name: "group",
    description: "move the highlighted session to a group",
    build: (cmd) => {
      cmd.argument("[group...]", "group name, created if new (leave out to edit)");
    },
  },
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
  { name: "name", description: "rename this session", build: nameArgument("show the current name") },
  { name: "rename", description: "rename this session (same as /name)", build: nameArgument("show the current name") },
  { name: "reload", description: "restart pi on this session to pick up new extensions and settings" },
  {
    name: "model",
    description: "show or switch the model",
    build: (cmd) => {
      cmd.argument("[query...]", "words that must all appear in provider/model (leave out to list)");
    },
  },
  {
    name: "fork",
    description: "continue in a copy of this session, listed right below it",
    build: (cmd) => {
      cmd
        .option("-n, --name <name>", "name for the copy (default: a fork mark plus this session's name)")
        .option("--no-switch", "stay in this session instead of entering the copy")
        .argument("[prompt...]", "first message for the copy; put -- before one that starts with -");
    },
  },
  { name: "clear", description: "wipe this session's conversation and start over (same name and model; old contents go to trash)" },
  {
    name: "compact",
    description: "summarize older context to free up the window",
    build: (cmd) => {
      cmd.argument("[focus...]", "what the summary should keep");
    },
  },
] as const satisfies readonly CommandSpec[];

export type SessionCommandName = (typeof SESSION_COMMANDS)[number]["name"];
