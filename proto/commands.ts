// Command registries: the one place a /command is declared. A command is a
// name, a description and (optionally) a `build` that declares its options and
// arguments on a commander Command (see cli.ts); parsing, -h/--help and
// autocomplete hints all derive from that. A handler table keyed by name
// (`Record<SwitcherCommandName, ...>` in switcher-actions.ts, likewise in
// session-commands.ts) makes the compiler insist that every command here has
// a handler, so adding one is: an entry here, plus a function there.
import type { Command } from "commander";
import type { CommandSpec } from "./cli.ts";
import { matching } from "./completion.ts";
import { mcpCompletions } from "./mcp.ts";

export type { CommandSpec };

const nameArgument = (verb: string) => (cmd: Command) => {
  cmd.argument("[name...]", `new name (leave out to ${verb})`);
};

/** Switcher command box. SwitcherActions must handle every name listed here. */
export const SWITCHER_COMMANDS = [
  {
    name: "new",
    description: "start a new session",
    build: (cmd) => {
      cmd
        .option("-n, --name <name>", "name for the new session")
        .option("-C, --cwd <dir>", "working directory for the new session (default: where ronpi was started)");
    },
  },
  { name: "stop", description: "stop the highlighted session's process (file kept; respawns on next prompt)" },
  {
    name: "delete",
    description: "move the highlighted session to trash (asks twice; stops it if running)",
    build: (cmd) => {
      cmd.option("-y, --yes", "skip the confirmation");
    },
  },
  { name: "rename", description: "rename the highlighted session", build: nameArgument("edit the current name") },
  {
    name: "group",
    description: "move the highlighted session to a group",
    complete: (typed, src) => matching(src.groups(), typed),
    build: (cmd) => {
      cmd.argument("[group...]", "group name, created if new (leave out to edit)");
    },
  },
  {
    name: "park",
    description: "park the highlighted session: shown in the oldest colour until you use it again",
    build: (cmd) => {
      cmd.option("-u, --undo", "unpark it");
    },
  },
  { name: "ungroup", description: "take the highlighted session out of its group" },
  {
    name: "summarize",
    description: "write a one-line summary of the highlighted session into the Summary column",
    build: (cmd) => {
      cmd
        .option("-m, --model <model>", "model to summarize with, provider/id (default: summaryModel in settings, else litellm/gemma4:12b)")
        .option("-c, --chars <n>", "most transcript characters to send (default 2500; smaller suits small models)", Number)
        .option("--all", "summarize every session that has no summary or a stale one, one after another");
    },
  },
  {
    name: "filter",
    description: "show only matching sessions until cleared (no text clears; ctrl-f filters as you type)",
    build: (cmd) => {
      cmd
        .option("-r, --regex", "treat the text as one case-insensitive regular expression")
        .argument("[text...]", "every word must appear in the name, summary, group, model or directory");
    },
  },
  {
    name: "feedback",
    description: "record a note about a harness or extension problem, with this session and turn attached, for later investigation",
    build: (cmd) => {
      cmd
        .option("-c, --category <name>", "short tag, e.g. tool-quirk, ui, extension")
        .option("-l, --list", "show the recent notes instead of adding one")
        .argument("[text...]", "what went wrong");
    },
  },
  { name: "adopt", description: "fork an external session into ronpi" },
  {
    name: "restore",
    description: "bring back a deleted session from the trash (pick from a list)",
    build: (cmd) => {
      cmd.argument("[query...]", "words that narrow the list; a single match is restored straight away");
    },
  },
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
  {
    name: "park",
    description: "park this session (oldest colour in the switcher until used again), stop it if idle, and go back to the list",
  },
  { name: "abort", description: "interrupt the running agent" },
  { name: "name", description: "rename this session", build: nameArgument("show the current name") },
  { name: "rename", description: "rename this session (same as /name)", build: nameArgument("show the current name") },
  { name: "reload", description: "restart pi on this session to pick up new extensions and settings" },
  {
    name: "model",
    description: "pick a model from a list, or switch to the one matching the words given",
    complete: async (typed, src) => matching(await src.models(), typed),
    build: (cmd) => {
      cmd.option("-l, --list", "just show every available model, without the picker").argument("[query...]", "words that must all appear in provider/model (leave out to pick from a list)");
    },
  },
  {
    name: "mcp",
    description: "list the MCP servers and their states, or reconnect / sign in to / sign out of one (tab completes names)",
    complete: async (typed, src) => mcpCompletions(typed, await src.mcpServers()),
    build: (cmd) => {
      cmd
        .argument("[action]", "list (default), reconnect, login or logout")
        .argument("[server]", "which server, for reconnect / login / logout (leave out to be asked)");
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
  {
    name: "feedback",
    description: "record a note about a harness or extension problem, with this session and turn attached, for later investigation",
    build: (cmd) => {
      cmd
        .option("-c, --category <name>", "short tag, e.g. tool-quirk, ui, extension")
        .option("-l, --list", "show the recent notes instead of adding one")
        .argument("[text...]", "what went wrong");
    },
  },
  {
    name: "why",
    description: "explain the last thinking block in a sentence or two, using the cheap summary model (the session's model is not involved)",
    build: (cmd) => {
      cmd.option("-m, --model <model>", "model to explain with (default: the summary model)");
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
