// Fork lineage: which session was forked from which. Kept in a ronpi-owned
// file next to the groups, keyed by session UUID (both directions), and a
// fork is told its parent through an appended system prompt. The parent is NOT
// told about its forks: a running child's system prompt is fixed at start, and
// restarting it just to update the prompt was rejected. See docs/design.md,
// "parent/child communication".
import * as fs from "node:fs";
import * as path from "node:path";
import { LINEAGE_FILE } from "./config.ts";

export interface SessionRef {
  id: string;
  name: string;
  file: string;
}

export interface LineageEntry {
  parent?: SessionRef;
  forks?: SessionRef[];
}

export type Lineage = Record<string, LineageEntry>;

export function loadLineage(file = LINEAGE_FILE): Lineage {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Lineage;
  } catch {
    return {};
  }
}

function saveLineage(data: Lineage, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** Record that `child` was forked from `parent`. */
export function recordFork(parent: SessionRef, child: SessionRef, file = LINEAGE_FILE): void {
  const data = loadLineage(file);
  const forks = (data[parent.id]?.forks ?? []).filter((f) => f.id !== child.id);
  data[parent.id] = { ...data[parent.id], forks: [...forks, child] };
  data[child.id] = { ...data[child.id], parent };
  saveLineage(data, file);
}

/** The session UUID from a session file's header line, if readable. */
export function sessionIdOfFile(file: string): string | undefined {
  try {
    const first = fs.readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
    const id = (JSON.parse(first) as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

const describe = (r: SessionRef) => `"${r.name}" (session id ${r.id}, file ${r.file})`;

/** System-prompt text for a session with this lineage (only its parent); undefined when it has none. */
export function lineageNote(entry: LineageEntry | undefined): string | undefined {
  const parts: string[] = [];
  if (entry?.parent) {
    parts.push(
      `This session is a fork of the session ${describe(entry.parent)}. It began as a copy of that session's conversation and has diverged since; the two now evolve independently.`,
    );
  }
  if (parts.length === 0) {
    return undefined;
  }
  return `ronpi session lineage:\n${parts.join("\n")}`;
}

/** `["--append-system-prompt", note]` for a session, or []. */
export function lineageArgs(sessionId: string | undefined, file = LINEAGE_FILE): string[] {
  const note = sessionId ? lineageNote(loadLineage(file)[sessionId]) : undefined;
  return note ? ["--append-system-prompt", note] : [];
}

/** What a freshly forked session is told, before it has an id of its own. */
export function forkNote(parent: SessionRef): string {
  return lineageNote({ parent }) as string;
}
