// /why: the last thinking block of a session, explained by the cheap summary
// model. Runs entirely outside the session - the session's own model never
// sees the request or the answer, so it costs the real model nothing.
import * as fs from "node:fs";
import { runSummarizer, summaryModel } from "./summarize.ts";
import { loadSettings, resolveChildConfig } from "./settings.ts";

/** Reasoning can be enormous; the start (the goal) and the end (the decision) matter most. */
export const MAX_THINKING_CHARS = 6000;

const PROMPT =
  "The text on stdin is the private reasoning of a coding assistant just before it acted. Explain in at most " +
  "four short plain sentences what it was trying to do and why it chose that. Reply with only the explanation - " +
  "no preamble, no bullet points.";

/** The thinking text of the newest assistant message in a session file that has any, or undefined. */
export function lastThinking(file: string): string | undefined {
  let found: string | undefined;
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
    if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) {
      continue;
    }
    const blocks = (entry.message.content as Array<{ type?: string; thinking?: string }>)
      .filter((b) => b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim())
      .map((b) => (b.thinking as string).trim());
    if (blocks.length > 0) {
      found = blocks.join("\n\n");
    }
  }
  return found;
}

export function clipThinking(text: string, max = MAX_THINKING_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  const head = Math.floor(max / 3);
  return `${text.slice(0, head)}\n[...]\n${text.slice(text.length - (max - head))}`;
}

export async function explainLastThinking(file: string, model?: string): Promise<string> {
  const thinking = lastThinking(file);
  if (!thinking) {
    throw new Error("no thinking block in this session (is thinking turned off?)");
  }
  return runSummarizer({
    piCli: resolveChildConfig(loadSettings().settings).piCli,
    model: model ?? summaryModel(),
    transcript: clipThinking(thinking),
    prompt: PROMPT,
    multiline: true,
  });
}
