// Rewind: cut a session file back to just before one of its user messages.
// Conversation only - files the agent edited are not restored. The removed
// tail is never discarded: it moves to the trash dir with a manifest, like a
// deleted session, so a rewind can be undone by hand (or a future /restore).
import * as fs from "node:fs";
import * as path from "node:path";
import { messageText } from "./format.ts";

export interface RewindTarget {
  /** Session entry id of the user message. */
  entryId: string;
  text: string;
  /** Entry time (ms since epoch); 0 when the entry has none. */
  ts: number;
}

export interface RewindResult {
  /** The rewound-to message's text, to put back in the editor. */
  text: string;
  /** Entries removed from the session. */
  removed: number;
  trashedTo: string;
}

interface ParsedLine {
  raw: string;
  entry?: { type?: string; id?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
}

function parseLines(file: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    if (!raw) {
      continue;
    }
    try {
      lines.push({ raw, entry: JSON.parse(raw) });
    } catch {
      lines.push({ raw }); // tolerate a torn line; it is kept or trimmed like any other
    }
  }
  return lines;
}

const isUserMessage = (l: ParsedLine): boolean =>
  l.entry?.type === "message" && l.entry.message?.role === "user" && typeof l.entry.id === "string";

/** The user messages of a session, oldest first. */
export function rewindTargets(file: string): RewindTarget[] {
  return parseLines(file)
    .filter(isUserMessage)
    .map((l) => ({
      entryId: l.entry!.id as string,
      text: messageText(l.entry!.message as never),
      ts: Date.parse(l.entry!.timestamp ?? "") || 0,
    }));
}

/** Truncate `file` to the entries before `entryId`; the tail goes to `trashDir`. */
export function rewindFile(file: string, entryId: string, trashDir: string, now: Date = new Date()): RewindResult {
  const lines = parseLines(file);
  const at = lines.findIndex((l) => isUserMessage(l) && l.entry?.id === entryId);
  if (at === -1) {
    throw new Error(`no user message ${entryId} in ${file}`);
  }
  const target = lines[at]!;
  const tail = lines.slice(at);
  fs.mkdirSync(trashDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const trashedTo = path.join(trashDir, `${stamp}-rewind-${path.basename(file)}`);
  fs.writeFileSync(trashedTo, `${tail.map((l) => l.raw).join("\n")}\n`);
  fs.writeFileSync(
    `${trashedTo}.json`,
    `${JSON.stringify({ originalPath: file, rewoundBeforeEntry: entryId, entries: tail.length, trashedAt: now.toISOString() }, null, 2)}\n`,
  );
  // Replace atomically so a crash never leaves a half-written session.
  const tmp = `${file}.rewind-${process.pid}`;
  fs.writeFileSync(tmp, lines.slice(0, at).map((l) => `${l.raw}\n`).join(""));
  fs.renameSync(tmp, file);
  return { text: messageText(target.entry!.message as never), removed: tail.length, trashedTo };
}
