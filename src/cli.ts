// Command-line parsing for toriel's own /commands: a shell-ish tokenizer plus
// commander for options, arguments, `--` and the generated -h/--help text.
// A command is declared once as a CommandSpec (commands.ts); everything here
// works from that, so adding a command needs no parsing code.
import { Command, CommanderError } from "commander";
import type { McpServer } from "./mcp.ts";

/** Live data an argument completer may draw on. */
export interface CompletionSources {
  /** Names (provider/id) of the models the viewed session can use. */
  models(): Promise<string[]>;
  /** Thinking levels the viewed session's model supports. */
  thinkingLevels(): Promise<string[]>;
  /** Existing group names. */
  groups(): string[];
  /** MCP servers of the viewed session, with their states. */
  mcpServers(): Promise<McpServer[]>;
  /** Agent profiles usable for a new session: name and one-line description. */
  agents(): Array<{ name: string; description: string }>;
}

/** A completion with a note shown beside it in the popup; a bare string has none. */
export type Choice = string | { value: string; description?: string };

export interface CommandSpec {
  name: string;
  description: string;
  /** Declare options and arguments on the commander Command. */
  build?: (cmd: Command) => void;
  /** Longer explanation and examples, printed after the options by --help. Every command that is not obvious from its description should have one. */
  help?: string;
  /**
   * Values to offer for the text typed after the command name (the whole rest
   * of the line). Only for arguments with a known set of choices; flags are
   * not completed.
   */
  complete?: (typed: string, sources: CompletionSources) => Choice[] | Promise<Choice[]>;
}

export interface Invocation {
  /** Positional arguments (a variadic argument contributes one entry per word). */
  args: string[];
  opts: Record<string, unknown>;
}

export type ParseResult =
  | { kind: "run"; spec: CommandSpec; call: Invocation }
  | { kind: "help"; spec: CommandSpec; text: string }
  | { kind: "error"; spec: CommandSpec; message: string }
  | { kind: "unknown"; name: string };

const HELP_WIDTH = 78;

/** The command name of a "/name args" line, lowercased. */
export function commandName(line: string): string {
  return (/^\/(\S*)/.exec(line)?.[1] ?? "").toLowerCase();
}

/**
 * Split a command line into words. Single and double quotes group words and
 * backslash escapes the next character (a space, a quote, a backslash). Two
 * deliberate leniencies, because this is chat text rather than a shell: a quote
 * only opens a group at the start of a word (or right after `=`), so the
 * apostrophe in `You're` is just a letter; and a backslash before any other
 * character stays as typed (`C:\temp`).
 */
export function tokenize(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && (line[i + 1] === '"' || line[i + 1] === "\\")) {
        cur += line[++i];
      } else {
        cur += ch;
      }
    } else if (ch === "\\" && i + 1 < line.length && /[\s"'\\]/.test(line[i + 1] as string)) {
      cur += line[++i];
      inWord = true;
    } else if ((ch === '"' || ch === "'") && (!inWord || cur.endsWith("="))) {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) {
        words.push(cur);
        cur = "";
        inWord = false;
      }
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) {
    throw new Error(`unterminated ${quote} (quote multi-word values, or escape a space with \\)`);
  }
  if (inWord) {
    words.push(cur);
  }
  return words;
}

/** A fresh commander Command for `spec`, named "/name" so usage and help read like what is typed. */
function commandFor(spec: CommandSpec, out: string[]): Command {
  const cmd = new Command(`/${spec.name}`);
  cmd
    .description(spec.description)
    .exitOverride()
    .configureHelp({ helpWidth: HELP_WIDTH })
    .configureOutput({
      writeOut: (s) => out.push(s),
      writeErr: () => {},
      outputError: () => {},
    });
  spec.build?.(cmd);
  if (spec.help) {
    cmd.addHelpText("after", `\n${spec.help}`);
  }
  return cmd;
}

/** Autocomplete hint, e.g. "[options] [prompt...]" or "<name>". */
export function usageHint(spec: CommandSpec): string {
  const cmd = commandFor(spec, []);
  const args = cmd.registeredArguments.map((a) => {
    const name = `${a.name()}${a.variadic ? "..." : ""}`;
    return a.required ? `<${name}>` : `[${name}]`;
  });
  const hasOptions = cmd.options.length > 0;
  return [...(hasOptions ? ["[options]"] : []), ...args].join(" ");
}

/** Parse a "/name args" line against `specs`. Unknown names are not ours to judge. */
export function parseCommandLine(specs: readonly CommandSpec[], line: string): ParseResult {
  const name = commandName(line);
  const spec = specs.find((c) => c.name === name);
  if (!spec) {
    return { kind: "unknown", name };
  }
  let words: string[];
  try {
    words = tokenize(line.slice(1 + name.length));
  } catch (err) {
    return { kind: "error", spec, message: err instanceof Error ? err.message : String(err) };
  }
  const out: string[] = [];
  const cmd = commandFor(spec, out);
  try {
    cmd.parse(words, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed") {
        return { kind: "help", spec, text: out.join("").trimEnd() };
      }
      return { kind: "error", spec, message: err.message.replace(/^error: /, "") };
    }
    throw err;
  }
  // an optional argument left out arrives as undefined, which must not become the text "undefined"
  const args = cmd.processedArgs.flat().filter((a) => a !== undefined).map(String);
  return { kind: "run", spec, call: { args, opts: cmd.opts() } };
}

/** One line per command: "/name <args>  description", for /help. */
export function listing(specs: readonly CommandSpec[]): string {
  const usages = specs.map((c) => `/${c.name} ${usageHint(c)}`.trimEnd());
  const pad = Math.max(...usages.map((u) => u.length));
  return [...specs.map((c, i) => `${(usages[i] as string).padEnd(pad)}  ${c.description}`), "", "/<command> --help for details"].join("\n");
}
