// One-line session summaries for the switcher's Summary column, written by a
// model run through pi's print mode (no session, no tools, no extensions), so
// it uses whatever providers pi is already set up with - including local ones.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { prettyError } from "./error-format.ts";
import { messageText } from "./format.ts";
import { loadSettings, resolveChildConfig } from "./settings.ts";

export const DEFAULT_SUMMARY_MODEL = "litellm/gemma4:12b";
/** Local models are slow; wait a good while before giving up. */
export const SUMMARY_TIMEOUT_MS = 5 * 60_000;
const MAX_LINE = 100;
/** Small local models choke on long input: keep the transcript short by default. */
export const DEFAULT_TRANSCRIPT_CHARS = 2500;
const PER_MESSAGE_CHARS = 250;
const PROMPT =
  "Summarize the coding-assistant conversation on stdin in ONE line of at most 80 characters: what the " +
  "session is about and where it stands. Reply with only that line - no quotes, no preamble.";

export interface SummaryEntry {
  text: string;
  /** User and assistant messages the summary covered; a different count means it is stale. */
  messages: number;
  at: string;
  model: string;
}

export const DEFAULT_MIN_NEW_MESSAGES = 6;
/** How often the automatic pass looks for changed sessions; it only does work when something changed. */
export const DEFAULT_INTERVAL_MINUTES = 60;
/** A session touched this recently is probably mid-conversation; summarize it later. */
export const QUIET_MS = 3 * 60_000;

/**
 * Whether a session needs a (new) summary: it has gained enough messages since
 * its last one (or since the start, if it has none), and is not mid-conversation
 * (running, or written to in the last few minutes).
 */
export function needsResummary(a: {
  entry: SummaryEntry | undefined;
  messages: number;
  modifiedMs: number;
  now: number;
  streaming: boolean;
  minNew?: number;
}): boolean {
  if (a.streaming || a.now - a.modifiedMs < QUIET_MS) {
    return false;
  }
  return a.messages - (a.entry?.messages ?? 0) >= (a.minNew ?? DEFAULT_MIN_NEW_MESSAGES);
}

/** The model to summarize with: settings file (summaryModel), RONPI_SUMMARY_MODEL, else the default. */
export function summaryModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.RONPI_SUMMARY_MODEL ?? loadSettings().settings.summaryModel ?? DEFAULT_SUMMARY_MODEL;
}

/**
 * The conversation as plain text for the summarizer: user and assistant
 * messages only, each clipped, and when too long the start and the most recent
 * part (what the session is about, and where it is now).
 */
export function transcriptOf(file: string, maxChars = DEFAULT_TRANSCRIPT_CHARS): { text: string; messages: number } {
  const parts: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) {
      continue;
    }
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry.message?.role;
    if (entry.type !== "message" || (role !== "user" && role !== "assistant")) {
      continue;
    }
    const text = messageText(entry.message as { content?: unknown }).replace(/\s+/g, " ").trim();
    if (text) {
      parts.push(`${role === "user" ? "User" : "Assistant"}: ${text.slice(0, PER_MESSAGE_CHARS)}`);
    }
  }
  let text = parts.join("\n");
  if (text.length > maxChars) {
    const head = Math.floor(maxChars / 3);
    text = `${text.slice(0, head)}\n[...]\n${text.slice(text.length - (maxChars - head))}`;
  }
  return { text, messages: parts.length };
}

/** First non-empty line of the model's reply, unquoted and capped. */
export function cleanSummary(raw: string): string {
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const unquoted = line.replace(/^["'`]+|["'`]+$/g, "").trim();
  return unquoted.length > MAX_LINE ? `${unquoted.slice(0, MAX_LINE - 3)}...` : unquoted;
}

/** pi ran fine but the model said nothing - typical of a small model given too much text. */
export class EmptyReplyError extends Error {
  constructor(stderr: string) {
    super(`the model returned no text${stderr ? ` (${stderr})` : ""} - try a smaller --chars or another -m model`);
  }
}

/**
 * What to tell the user when pi exits non-zero: its last real error line(s),
 * unwrapped like any provider error, plus what to try for the usual causes.
 * pi's own "Warning:" lines are noise here.
 */
export function describeFailure(model: string, stderr: string, code: number | null): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^warning:/i.test(l));
  // a proxy's HTML error page: keep its text, not its markup
  const text = lines.slice(-2).join(" ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const detail = prettyError(text || `exit ${code}`);
  let hint = "";
  if (/not found/i.test(detail)) {
    hint = " - check summaryModel in the ronpi settings, or pass -m provider/id";
  } else if (/connection error|econnrefused|enotfound|fetch failed/i.test(detail)) {
    hint = " - the model's server is unreachable";
  }
  return `summarizer (${model}) failed: ${detail}${hint}`;
}

export interface SummarizerOptions {
  piCli: string;
  model: string;
  transcript: string;
  timeoutMs?: number;
  /** Instruction for the model (default: the one-line session summary). */
  prompt?: string;
  /** Keep the whole reply, trimmed, instead of its first line capped at one summary line. */
  multiline?: boolean;
}

/** Run pi once in print mode over `transcript`; rejects with pi's stderr on failure. */
export function runSummarizer(opts: SummarizerOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        opts.piCli,
        "--print",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--thinking",
        "off",
        "--model",
        opts.model,
        opts.prompt ?? PROMPT,
      ],
      { cwd: os.tmpdir(), env: { ...process.env, RONPI_CHILD: "1" }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${opts.model} timed out after ${Math.round((opts.timeoutMs ?? SUMMARY_TIMEOUT_MS) / 1000)}s`));
    }, opts.timeoutMs ?? SUMMARY_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const summary = opts.multiline ? out.trim() : cleanSummary(out);
      if (code === 0 && summary) {
        resolve(summary);
      } else if (code === 0) {
        reject(new EmptyReplyError(err.trim().split("\n").slice(-2).join(" ")));
      } else {
        reject(new Error(describeFailure(opts.model, err, code)));
      }
    });
    child.stdin.on("error", () => {
      // the process may exit before reading stdin; the close handler reports why
    });
    child.stdin.end(opts.transcript);
  });
}

/** Summarize one session file with `model`, sending at most about `maxChars` of transcript. */
export async function summarizeFile(file: string, model: string, maxChars = DEFAULT_TRANSCRIPT_CHARS): Promise<SummaryEntry> {
  const { text, messages } = transcriptOf(file, maxChars);
  if (messages === 0) {
    throw new Error("nothing to summarize yet");
  }
  const piCli = resolveChildConfig(loadSettings().settings).piCli;
  let summary: string;
  try {
    summary = await runSummarizer({ piCli, model, transcript: text });
  } catch (err) {
    if (!(err instanceof EmptyReplyError)) {
      throw err;
    }
    // once more with half the text before giving up
    const shorter = transcriptOf(file, Math.max(400, Math.floor(maxChars / 2)));
    summary = await runSummarizer({ piCli, model, transcript: shorter.text });
  }
  return { text: summary, messages, at: new Date().toISOString(), model };
}
