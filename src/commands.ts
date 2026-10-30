// Command registries: the one place a /command is declared. A command is a
// name, a description and (optionally) a `build` that declares its options and
// arguments on a commander Command (see cli.ts); parsing, -h/--help and
// autocomplete hints all derive from that. A handler table keyed by name
// (`Record<SwitcherCommandName, ...>` in switcher-actions.ts, likewise in
// session-commands.ts) makes the compiler insist that every command here has
// a handler, so adding one is: an entry here, plus a function there.
// A session command that talks to a running pi child must also wake a sleeping
// session first (`liveMeta()` in session-commands.ts; see AGENTS.md).
import type { Command } from "commander";
import type { CommandSpec } from "./cli.ts";
import { agentCompletions } from "./agents-completion.ts";
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
    help: "Starts an empty session and opens it. It runs in the directory ronpi was started from unless -C says otherwise.\nExamples:\n  /new\n  /new -n \"Mealie import\" -C ~/projects/mealie\n  /new -a explore          (a read-only agent profile; see /agents)",
    build: (cmd) => {
      cmd
        .option("-n, --name <name>", "name for the new session")
        .option("-C, --cwd <dir>", "working directory for the new session (default: where ronpi was started)")
        .option("-a, --agent <name>", "start it as an agent profile (see /agents; tab completes the name after -a)");
    },
    // flags are not completed in general; this one value is worth it
    complete: (typed, src) => agentCompletions(typed, src.agents()),
  },
  { name: "agents", description: "list the agent profiles (/new --agent <name> starts one) and any problems loading them",
    help: "Agent profiles are markdown files (agents/ in the ronpi repo, ~/.config/ronpi/agents/, <project>/.ronpi/agents/). A broken file is listed under Problems and the rest still load. Format: agents/README.md." },
  { name: "stop", description: "stop the highlighted session's process (file kept; respawns on next prompt)",
    help: "Stops the highlighted session's pi process but keeps its file; the next message (or /reload, /model, !command) starts it again. Use it to free memory or MCP servers." },
  {
    name: "delete",
    description: "move the highlighted session to trash (asks twice; stops it if running)",
    help: "Moves the session file to ronpi's trash; /restore brings it back. Without -y you press ctrl-x (or enter the command) a second time to confirm. A running session is stopped first. Sessions nested under it stay.",
    build: (cmd) => {
      cmd.option("-y, --yes", "skip the confirmation");
    },
  },
  { name: "rename", description: "rename the highlighted session",
    help: "Names the highlighted session. Names are kept unique: a taken name gets ' #2'. With no name the current one is put in the box to edit.", build: nameArgument("edit the current name") },
  {
    name: "group",
    description: "move the highlighted session to a group",
    help: "Groups are the headers in the list. The group is created if it does not exist; with no name the current group is put in the box. Tab completes existing groups. shift+up/down also moves a session between groups.",
    complete: (typed, src) => matching(src.groups(), typed),
    build: (cmd) => {
      cmd.argument("[group...]", "group name, created if new (leave out to edit)");
    },
  },
  {
    name: "park",
    description: "park the highlighted session: shown in the oldest colour until you use it again",
    help: "Parking is a marker, not a state: the session is drawn in the oldest colour until you use it again. A parked subagent is hidden under its parent (/filter shows it).\nExample: /park -u   (unpark)",
    build: (cmd) => {
      cmd.option("-u, --undo", "unpark it");
    },
  },
  { name: "detach", description: "cut the highlighted subagent loose from the agent that started it (it becomes a top-level session)",
    help: "Removes the parent link of a session an agent started, in both directions, so it becomes an ordinary top-level session. Does nothing for sessions without such a link (copies made with /fork or /adopt are never nested)." },
  { name: "ungroup", description: "take the highlighted session out of its group",
    help: "Takes the session out of its group (it goes to the ungrouped list at the top)." },
  {
    name: "summarize",
    description: "write a one-line summary of the highlighted session into the Summary column",
    help: "Asks a small model for a one-line summary of the transcript and stores it for the Summary column. The model defaults to summaryModel in the ronpi settings, else litellm/gemma4:12b. ronpi also refreshes summaries by itself while it is open.\nExamples:\n  /summarize\n  /summarize --all -c 1500 -m litellm/gemma4:12b",
    build: (cmd) => {
      cmd
        .option("-m, --model <model>", "model to summarize with, provider/id (default: summaryModel in settings, else litellm/gemma4:12b)")
        .option("-c, --chars <n>", "most transcript characters to send (default 2500; smaller suits small models)", Number)
        .option("--all", "summarize every session that has no summary or a stale one, one after another");
    },
  },
  {
    name: "comment",
    description: "keep a note to yourself about the highlighted session (hidden, but found by the filter)",
    help: "Stores a longer note about why the session exists and where it stands. It is not drawn in the list; /filter and ctrl-f search it. With no text the current comment is put in the box to edit; /comment -c removes it.\nExamples:\n  /comment waiting on the vendor, retry the import after friday\n  /comment -c",
    build: (cmd) => {
      cmd.option("-c, --clear", "remove the comment").argument("[text...]", "the note (leave out to edit the current one)");
    },
  },
  {
    name: "filter",
    description: "show only matching sessions until cleared (no text clears; ctrl-f filters as you type)",
    help: "Narrows the list until cleared; folds are ignored while a filter is on, and parked subagents show again. Run /filter with no text, or press esc, to clear.\nExamples:\n  /filter mealie\n  /filter -r \"mealie|freecad\"",
    build: (cmd) => {
      cmd
        .option("-r, --regex", "treat the text as one case-insensitive regular expression")
        .argument("[text...]", "every word must appear in the name, summary, group, model or directory");
    },
  },
  {
    name: "feedback",
    description: "record a note about a harness or extension problem, with this session and turn attached, for later investigation",
    help: "Saves a note (with this session and the last turn attached) to ronpi's feedback log so a harness or extension problem can be looked at later. -l lists recent notes.\nExample: /feedback -c tool-quirk the grep tool ignored my path",
    build: (cmd) => {
      cmd
        .option("-c, --category <name>", "short tag, e.g. tool-quirk, ui, extension")
        .option("-l, --list", "show the recent notes instead of adding one")
        .argument("[text...]", "what went wrong");
    },
  },
  { name: "adopt", description: "fork an external session into ronpi",
    help: "Forks a session that is open in a plain pi process into ronpi (pi keeps its own copy). The fork is an ordinary session. Needs the session to have been saved by pi at least once." },
  {
    name: "restore",
    description: "bring back a deleted session from the trash (pick from a list)",
    help: "Lists sessions in the trash (name, age, size, directory). Type words to narrow the list; if one matches it is restored directly, with its group and summary.",
    build: (cmd) => {
      cmd.argument("[query...]", "words that narrow the list; a single match is restored straight away");
    },
  },
  { name: "kill-daemon", description: "stop the daemon and every session it owns",
    help: "Stops the daemon and every pi session it runs, ending any work in progress. Sessions can be resumed afterwards: their files are kept. Use /exit to leave ronpi without stopping anything." },
  { name: "help", description: "list commands",
    help: "Lists ronpi's own commands. <command> --help describes one. Anything else typed with a leading / goes to pi (skills, prompt templates, extension commands)." },
  { name: "exit", description: "leave ronpi (sessions keep running)",
    help: "Closes ronpi only. The daemon and every running session keep going; start ronpi again to reattach." },
  { name: "quit", description: "leave ronpi (sessions keep running)",
    help: "Same as /exit: closes ronpi only; the daemon and every running session keep going." },
] as const satisfies readonly CommandSpec[];

export type SwitcherCommandName = (typeof SWITCHER_COMMANDS)[number]["name"];

/** Handled by ronpi inside a session; everything else goes to pi. */
export const SESSION_COMMANDS = [
  {
    name: "btw",
    description: "ask a side question about this session; the answer pops up and the session never sees it",
    help: "Asks a copy of this session (it has read the whole conversation but has no tools) one question in the background, so you can keep working. The answer opens in a panel: c copies it, s saves it to a file, any other key closes. Nothing is added to the session and its own model is not interrupted. Uses the session's model unless -m is given.\nExamples:\n  /btw why did you choose sqlite over a json file?\n  /btw -m litellm/gemma4:12b what is left to do?",
    build: (cmd) => {
      cmd
        .option("-m, --model <model>", "model to ask, provider/id (default: this session's model)")
        .argument("<question...>", "the question");
    },
  },
  {
    name: "comment",
    description: "keep a note to yourself about this session (hidden, but found by the switcher filter)",
    help: "Stores a longer note about why the session exists and where it stands. It is not drawn in the list; the switcher's /filter and ctrl-f search it. With no text the current comment is shown; /comment -c removes it.\nExamples:\n  /comment waiting on the vendor, retry the import after friday\n  /comment -c",
    build: (cmd) => {
      cmd.option("-c, --clear", "remove the comment").argument("[text...]", "the note (leave out to show the current one)");
    },
  },
  { name: "exit", description: "leave ronpi (sessions keep running)",
    help: "Closes ronpi only. The daemon and every running session keep going; start ronpi again to reattach." },
  { name: "quit", description: "back to the session list",
    help: "Goes back to the list without stopping this session (use /park to also stop it)." },
  {
    name: "park",
    description: "park this session (oldest colour in the switcher until used again), stop it if idle, and go back to the list",
    help: "Marks the session parked (oldest colour in the list; hidden if it is a subagent), stops it if it is idle, and goes back to the list. Using it again unparks it.",
  },
  {
    name: "help",
    description: "list ronpi's commands for a session",
    help: "<command> --help describes one. Anything else typed with a leading / goes to pi (skills, prompt templates, extension commands).",
  },
  { name: "abort", description: "interrupt the running agent",
    help: "Interrupts the agent's current turn, like esc. Messages still queued come back into the box." },
  { name: "detach", description: "cut this subagent loose from the agent that started it (no more banner or nesting)",
    help: "Removes the parent link of this session when an agent started it, so it stops being nested and the banner goes. Does nothing for copies made with /fork or /adopt, which are never nested." },
  { name: "parent", description: "jump to the agent that started this subagent",
    help: "Opens the agent that started this subagent. Says so when this session was not started by an agent." },
  { name: "name", description: "rename this session",
    help: "Shows the session's name and id when called with no name; with a name it renames the session (kept unique: a taken name gets ' #2').\nExample: /name Mealie import", build: nameArgument("show the current name") },
  { name: "rename", description: "rename this session (same as /name)",
    help: "Same as /name: renames this session (kept unique: a taken name gets ' #2'); with no name it shows the current name and id.", build: nameArgument("show the current name") },
  { name: "reload", description: "restart pi on this session to pick up new extensions and settings",
    help: "Restarts pi on this session's file so new extensions, skills, prompt templates and settings are read. Refused while the agent is working (abort it first). A sleeping session is simply started (which loads everything fresh)." },
  {
    name: "model",
    description: "pick a model from a list, or switch to the one matching the words given",
    help: "With no words opens a picker; with words switches to the one model whose provider/id contains all of them (an error lists the candidates if several do). The session's own model is kept across restarts.\nExamples:\n  /model\n  /model -l\n  /model glm flash",
    complete: async (typed, src) => matching(await src.models(), typed),
    build: (cmd) => {
      cmd.option("-l, --list", "just show every available model, without the picker").argument("[query...]", "words that must all appear in provider/model (leave out to pick from a list)");
    },
  },
  {
    name: "mcp",
    description: "list the MCP servers and their states, troubleshoot, add or remove one, or reconnect / sign in to / sign out of one, or have the agent write a skill for one (tab completes names)",
    help: "Actions:\n  list                  every MCP server with its state (default); a configured server with no matching skill (a skill dir or SKILL.md naming it in the pi agent dir's skills/) gets a hint line\n  status [server]       troubleshoot: each server's state and error text, how it is configured (secrets hidden), whether its command is installed or its URL answers, and what to try. Checks every server that is not connected, or the one named\n  explore <server>      the agent introspects that server (every tool with its full parameter schema, resources) and writes a pi-format skill for it: SKILL.md in a subdirectory of the pi agent dir's skills/ (updates one if it already exists); says so instead when the server is not a configured mcp.json server, or is not connected (then it suggests /mcp reconnect)\n  add <name> <target>   write a server into pi's mcp.json and reload; <target> is a URL or a command with its arguments\n  remove <server>       take a server out of pi's mcp.json and reload (its saved sign-in is kept; other open sessions keep it until reloaded)\n  reconnect [server]    reconnect a server (tab completes names; leave out to pick)\n  login / logout [server]   OAuth sign in or out\nAll enabled servers connect when a session starts; a new server needs this session reloaded (add does that).\nExamples:\n  /mcp\n  /mcp add docs https://example.com/mcp\n  /mcp add mealie -- podman run -i --rm ghcr.io/example/mealie-mcp\n  /mcp status\n  /mcp status freecad\n  /mcp explore freecad\n  /mcp remove docs\n  /mcp reconnect freecad",
    complete: async (typed, src) => mcpCompletions(typed, await src.mcpServers()),
    build: (cmd) => {
      cmd
        .argument("[action]", "list (default), status, explore, add, remove, reconnect, login or logout")
        .argument("[server]", "which server (for add, the name to give it); leave out to be asked for reconnect / login / logout (status: all); remove and explore need it")
        .argument("[target...]", "for add: a URL, or a command and its arguments; put -- before arguments that start with -");
    },
  },
  {
    name: "fork",
    description: "continue in a copy of this session, listed right below it",
    help: "Makes a copy of this session's file and continues in the copy; the original is untouched. The copy knows it is a fork, but is an ordinary session in the list (not nested). With a prompt the copy starts working on it at once.\nExamples:\n  /fork\n  /fork -n \"Try the other approach\" --no-switch\n  /fork -- -v is the flag I meant",
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
    help: "Saves a note (with this session and the last turn attached) to ronpi's feedback log. -l lists recent notes.\nExample: /feedback -c ui the popup covers the input",
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
    help: "Asks the cheap summary model (not this session's) to explain the last thinking block in a sentence or two; nothing is added to the conversation.",
    build: (cmd) => {
      cmd.option("-m, --model <model>", "model to explain with (default: the summary model)");
    },
  },
  {
    name: "init",
    description: "have the agent survey the project and write an AGENTS.md (what it is, layout, conventions); updates one that exists and folds in CLAUDE.md and other agent-instruction files",
    help: "Sends the agent a prompt to survey the project and write AGENTS.md, or update the one that exists, folding in CLAUDE.md and other agent-instruction files. The agent does the scanning with its normal tools.",
  },
  { name: "clear", description: "wipe this session's conversation and start over (same name and model; old contents go to trash)",
    help: "Empties the conversation but keeps the session, its name and model. The old contents go to trash; esc esc offers to undo it." },
  {
    name: "compact",
    description: "summarize older context to free up the window",
    help: "Summarizes older context to free up the window. Messages you send meanwhile are held and delivered after. The focus text tells the summary what to keep.\nExample: /compact keep the schema decisions and the open questions",
    build: (cmd) => {
      cmd.argument("[focus...]", "what the summary should keep");
    },
  },
] as const satisfies readonly CommandSpec[];

export type SessionCommandName = (typeof SESSION_COMMANDS)[number]["name"];
