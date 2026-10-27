// Input history beyond what a session file holds. A session's own user
// messages (with timestamps) cover prompts; slash commands never reach the
// session file, so they live in one small ronpi log shared by the session
// editor and the switcher box. Up-arrow history merges the two by time.
import * as fs from "node:fs";
import * as path from "node:path";

export interface HistoryEntry {
  ts: number;
  text: string;
}

/** Entries of the command log, oldest first; unreadable lines are skipped. */
export function loadCommands(file: string): HistoryEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    try {
      const e = JSON.parse(line) as Partial<HistoryEntry>;
      if (typeof e.ts === "number" && typeof e.text === "string") {
        entries.push({ ts: e.ts, text: e.text });
      }
    } catch {
      // blank or torn line
    }
  }
  return entries;
}

export function recordCommand(file: string, text: string, now: number = Date.now()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: now, text })}\n`);
  } catch {
    // history is a convenience; never fail a command over it
  }
}

/** Keep only the newest `keep` entries (run at startup so the log cannot grow forever). */
export function trimCommands(file: string, keep = 500): void {
  const entries = loadCommands(file);
  if (entries.length <= keep) {
    return;
  }
  try {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, entries.slice(-keep).map((e) => `${JSON.stringify(e)}\n`).join(""));
    fs.renameSync(tmp, file);
  } catch {
    // best effort
  }
}

const SAME_SUBMISSION_MS = 5000;

/** Texts oldest first: prompts and commands interleaved by time. */
export function mergeHistory(prompts: HistoryEntry[], commands: HistoryEntry[]): string[] {
  // pi runs some slash commands as prompts, so they can be in both sources
  const fresh = commands.filter(
    (c) => !prompts.some((p) => p.text.trim() === c.text && Math.abs(p.ts - c.ts) <= SAME_SUBMISSION_MS),
  );
  return [...prompts, ...fresh]
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => a.ts - b.ts || a.i - b.i)
    .map((e) => e.text);
}
