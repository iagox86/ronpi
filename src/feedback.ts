// Notes about problems with the harness or its extensions, kept for later
// investigation: one JSON object per line. `source` is "user" for /feedback
// today; an agent-facing tool can write the same records with "agent".
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { FEEDBACK_FILE } from "./config.ts";

/**
 * One line of feedback.jsonl. To investigate a record: open `session.file`; line
 * `session.entryLine` (1-based) is the session entry whose `id` is `session.entryId`
 * - the newest turn when the note was made; the problem is usually in or just
 * before it. `at` (UTC) lines up with timestamps in `env.daemonLog`.
 */
export interface FeedbackRecord {
  v?: 1;
  /** Unique, for referring to a record. */
  id?: string;
  at: string;
  source: "user" | "agent";
  text: string;
  category?: string;
  session?: {
    file?: string;
    /** pi's session uuid (from the file header). */
    sessionId?: string;
    name?: string;
    model?: string;
    provider?: string;
    entryId?: string;
    entryLine?: number;
    entryTimestamp?: string;
    /** Entries in the file when noted. */
    entries?: number;
  };
  cwd?: string;
  env?: { toriel?: string; pi?: string; daemonLog?: string };
}

/** Append a record, filling in its version and id. */
export function appendFeedback(record: FeedbackRecord, file = FEEDBACK_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ v: 1, id: randomUUID(), ...record })}\n`);
}

/** All records, oldest first; unreadable lines are skipped. */
export function readFeedback(file = FEEDBACK_FILE): FeedbackRecord[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  const out: FeedbackRecord[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    try {
      const r = JSON.parse(line) as FeedbackRecord;
      if (typeof r?.text === "string") {
        out.push(r);
      }
    } catch {
      // blank or torn line
    }
  }
  return out;
}

export interface SessionPosition {
  sessionId?: string;
  entryId?: string;
  entryLine?: number;
  entryTimestamp?: string;
  entries: number;
}

/** Where a session file stands now: its uuid and its newest entry (id, 1-based line, time). */
export function sessionPosition(sessionFile: string | undefined): SessionPosition | undefined {
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return undefined;
  }
  const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const parse = (line: string | undefined): Record<string, unknown> | undefined => {
    try {
      return JSON.parse(line as string) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  const header = parse(lines[0]);
  const pos: SessionPosition = {
    sessionId: header?.type === "session" && typeof header.id === "string" ? header.id : undefined,
    entries: Math.max(0, lines.length - 1),
  };
  for (let i = lines.length - 1; i >= 1; i--) {
    const entry = parse(lines[i]); // the last line may be torn
    if (typeof entry?.id === "string") {
      pos.entryId = entry.id;
      pos.entryLine = i + 1;
      pos.entryTimestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
      break;
    }
  }
  return pos;
}

/** Short git hash of the toriel checkout, if it is one. */
export function torielRevision(root = path.join(import.meta.dirname, "..")): string | undefined {
  try {
    const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
    const hash = head.startsWith("ref: ") ? fs.readFileSync(path.join(root, ".git", head.slice(5)), "utf8").trim() : head;
    return hash.slice(0, 10);
  } catch {
    return undefined;
  }
}

/** Version of the pi install at `piCli` (its package.json sits one level above dist/). */
export function piVersion(piCli: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(piCli), "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/** The newest `limit` records as display lines, newest last. */
export function formatFeedback(records: FeedbackRecord[], limit = 12): string {
  if (records.length === 0) {
    return "no feedback recorded yet - /feedback <what went wrong>";
  }
  const shown = records.slice(-limit);
  const lines = shown.map((r) => {
    const when = r.at.slice(0, 16).replace("T", " ");
    const tag = r.category ? ` [${r.category}]` : "";
    const where = r.session?.name ?? (r.session?.file ? path.basename(r.session.file) : "");
    const by = r.source === "agent" ? " (agent)" : "";
    return `${when}${tag}${by}${where ? ` - ${where}` : ""}\n  ${r.text.replace(/\s+/g, " ")}`;
  });
  const hidden = records.length - shown.length;
  return [hidden > 0 ? `${hidden} older not shown` : "", ...lines, "", `file: ${FEEDBACK_FILE}`].filter((l, i) => l !== "" || i > 0).join("\n");
}
