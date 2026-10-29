// Session files ronpi has run a child on, persisted across daemon restarts. A
// restarted daemon forgets its registry, and the file of a session it was
// running a minute ago has a fresh mtime; without this record the "may be open
// in another pi" check (daemon-handlers-lifecycle.ts) would ask about ronpi's own
// sessions. Keyed by absolute path; only ever grows (a few hundred bytes a session).
import * as fs from "node:fs";
import * as path from "node:path";
import { HANDLED_FILE } from "./config.ts";

function load(file: string): Set<string> {
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function wasHandled(sessionFile: string, file = HANDLED_FILE): boolean {
  return load(file).has(sessionFile);
}

/** Remember that ronpi ran a child on `sessionFile`; a write failure is logged by the caller, not fatal. */
export function recordHandled(sessionFile: string, file = HANDLED_FILE): void {
  const set = load(file);
  if (set.has(sessionFile)) {
    return;
  }
  set.add(sessionFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify([...set], null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}
