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
  /** A compaction came after this message, so rewinding here also undoes it. */
  compacted?: boolean;
  /** Set on the one pseudo-entry that undoes a /clear instead of rewinding. */
  restore?: { entries: number; trashedAt: string };
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
  const lines = parseLines(file);
  const lastCompaction = lines.findLastIndex((l) => l.entry?.type === "compaction");
  return lines.flatMap((l, i) =>
    isUserMessage(l)
      ? [
          {
            entryId: l.entry!.id as string,
            text: messageText(l.entry!.message as never),
            ts: Date.parse(l.entry!.timestamp ?? "") || 0,
            ...(i < lastCompaction ? { compacted: true } : {}),
          },
        ]
      : [],
  );
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

/**
 * Wipe a session's conversation but keep the session itself: the file keeps
 * its header and its latest model, thinking-level and name entries (relinked
 * into one chain), so a restarted pi resumes it empty, under the same name and
 * model. The whole previous file is copied to `trashDir` first.
 */
export function clearFile(file: string, trashDir: string, now: Date = new Date()): { removed: number; trashedTo: string } {
  const lines = parseLines(file);
  const lastOf = (type: string): ParsedLine | undefined => lines.findLast((l) => l.entry?.type === type && typeof l.entry.id === "string");
  const header = lines.find((l) => l.entry?.type === "session");
  const keep = [lastOf("model_change"), lastOf("thinking_level_change"), lastOf("session_info")].filter((l): l is ParsedLine => l !== undefined);
  keep.sort((a, b) => lines.indexOf(a) - lines.indexOf(b));
  fs.mkdirSync(trashDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const trashedTo = path.join(trashDir, `${stamp}-clear-${path.basename(file)}`);
  fs.copyFileSync(file, trashedTo);
  fs.writeFileSync(
    `${trashedTo}.json`,
    `${JSON.stringify({ originalPath: file, cleared: true, entries: lines.length, trashedAt: now.toISOString() }, null, 2)}\n`,
  );
  let parent: string | null = null;
  const out: string[] = header ? [header.raw] : [];
  for (const l of keep) {
    const entry = { ...l.entry, parentId: parent };
    out.push(JSON.stringify(entry));
    parent = l.entry!.id as string;
  }
  const tmp = `${file}.clear-${process.pid}`;
  fs.writeFileSync(tmp, out.map((l) => `${l}\n`).join(""));
  fs.renameSync(tmp, file);
  return { removed: lines.length - out.length, trashedTo };
}

export interface ClearBackup {
  /** The copy of the session file taken by clearFile. */
  trashedTo: string;
  entries: number;
  trashedAt: string;
}

/**
 * The newest clear backup of `file` that has not been restored, if any (clearFile
 * writes a manifest next to each copy).
 */
export function latestClearBackup(trashDir: string, file: string): ClearBackup | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(trashDir).filter((n) => n.endsWith(".jsonl.json"));
  } catch {
    return undefined;
  }
  let best: ClearBackup | undefined;
  for (const name of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(trashDir, name), "utf8")) as {
        originalPath?: string;
        cleared?: boolean;
        restoredAt?: string;
        entries?: number;
        trashedAt?: string;
      };
      const trashedTo = path.join(trashDir, name.slice(0, -".json".length));
      if (m.cleared && !m.restoredAt && m.originalPath === file && fs.existsSync(trashedTo)) {
        if (!best || (m.trashedAt ?? "") > best.trashedAt) {
          best = { trashedTo, entries: m.entries ?? 0, trashedAt: m.trashedAt ?? "" };
        }
      }
    } catch {
      // an unreadable manifest is just not offered
    }
  }
  return best;
}

/** Put a cleared session's old contents back; the backup is marked used so it is offered once. */
export function restoreClear(file: string, backup: ClearBackup, now: Date = new Date()): void {
  const tmp = `${file}.restore-${process.pid}`;
  fs.copyFileSync(backup.trashedTo, tmp);
  fs.renameSync(tmp, file);
  const manifest = `${backup.trashedTo}.json`;
  const data = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(manifest, `${JSON.stringify({ ...data, restoredAt: now.toISOString() }, null, 2)}\n`);
}
