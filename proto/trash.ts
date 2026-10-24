// Deletes never unlink: the session file is the only copy of a session, so it
// moves to the trash dir with a manifest (original path + timestamp) that
// /restore reads.
import * as fs from "node:fs";
import * as path from "node:path";
import { messageText } from "./format.ts";

/** Move `file` into `trashDir`; returns the new location. */
export function trashSessionFile(file: string, trashDir: string): string {
  if (!fs.existsSync(file)) {
    throw new Error(`session file does not exist: ${file}`);
  }
  fs.mkdirSync(trashDir, { recursive: true });
  const base = path.basename(file);
  let target = path.join(trashDir, base);
  if (fs.existsSync(target)) {
    target = path.join(trashDir, `${Date.now()}-${base}`);
  }
  fs.renameSync(file, target);
  fs.writeFileSync(
    `${target}.json`,
    `${JSON.stringify({ originalPath: file, trashedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return target;
}

export interface TrashedSession {
  /** Where the file sits in the trash dir. */
  trashedTo: string;
  originalPath: string;
  trashedAt: string;
  /** Session UUID from the file header. */
  sessionId?: string;
  name?: string;
  firstMessage?: string;
  /** User and assistant messages in the file. */
  messages: number;
  cwd?: string;
}

/** What the session file itself says about the session (best effort). */
function describeSessionFile(file: string): Pick<TrashedSession, "sessionId" | "name" | "firstMessage" | "messages" | "cwd"> {
  let sessionId: string | undefined;
  let name: string | undefined;
  let firstMessage: string | undefined;
  let cwd: string | undefined;
  let messages = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) {
      continue;
    }
    try {
      const e = JSON.parse(line) as {
        type?: string;
        id?: string;
        cwd?: string;
        name?: string;
        message?: { role?: string; content?: unknown };
      };
      if (e.type === "session") {
        sessionId = e.id;
        cwd = e.cwd;
      } else if (e.type === "session_info" && e.name) {
        name = e.name;
      } else if (e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant")) {
        messages++;
        if (e.message.role === "user" && firstMessage === undefined) {
          firstMessage = messageText(e.message);
        }
      }
    } catch {
      // a torn line is skipped
    }
  }
  return { sessionId, name, firstMessage, messages, cwd };
}

/**
 * Deleted sessions in the trash, newest first. Rewind tails and clear backups
 * live in the same directory but are not whole sessions, so they are left out,
 * as is anything already restored.
 */
export function listTrashedSessions(trashDir: string): TrashedSession[] {
  let names: string[];
  try {
    names = fs.readdirSync(trashDir).filter((n) => n.endsWith(".jsonl.json"));
  } catch {
    return [];
  }
  const out: TrashedSession[] = [];
  for (const name of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(trashDir, name), "utf8")) as Record<string, unknown>;
      const trashedTo = path.join(trashDir, name.slice(0, -".json".length));
      if (typeof m.originalPath !== "string" || m.rewoundBeforeEntry !== undefined || m.cleared || !fs.existsSync(trashedTo)) {
        continue;
      }
      out.push({
        trashedTo,
        originalPath: m.originalPath,
        trashedAt: typeof m.trashedAt === "string" ? m.trashedAt : "",
        ...describeSessionFile(trashedTo),
      });
    } catch {
      // an unreadable entry is just not offered
    }
  }
  return out.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
}

/**
 * Move a trashed session back to where it was deleted from. Refuses a path
 * outside the trash dir, and an original path that is taken again. Returns the
 * restored path.
 */
export function restoreTrashedSession(trashedTo: string, trashDir: string): string {
  const resolved = path.resolve(trashedTo);
  if (path.dirname(resolved) !== path.resolve(trashDir)) {
    throw new Error("not a file in the trash");
  }
  const manifest = `${resolved}.json`;
  const { originalPath } = JSON.parse(fs.readFileSync(manifest, "utf8")) as { originalPath?: string };
  if (typeof originalPath !== "string" || !fs.existsSync(resolved)) {
    throw new Error("that trash entry has no usable manifest");
  }
  if (fs.existsSync(originalPath)) {
    throw new Error(`${originalPath} already exists`);
  }
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.renameSync(resolved, originalPath);
  fs.unlinkSync(manifest);
  return originalPath;
}
