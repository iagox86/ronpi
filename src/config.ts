// Paths and constants shared by the daemon and the controller. Everything is
// derived from the environment at import time, so tests isolate a daemon by
// setting RONPI_SOCK / RONPI_LOG / RONPI_TRASH / XDG_DATA_HOME before spawning.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function sockPath(): string {
  if (process.env.RONPI_SOCK) {
    return process.env.RONPI_SOCK;
  }
  // No /tmp fallback: the socket takes unauthenticated commands, so it only ever
  // lives in a per-user directory.
  if (!process.env.XDG_RUNTIME_DIR) {
    throw new Error("XDG_RUNTIME_DIR is not set; set it or set RONPI_SOCK to a path in a private (0700) directory");
  }
  return `${process.env.XDG_RUNTIME_DIR}/ronpi.sock`;
}
export const SOCK = sockPath();
export const PID_FILE = `${SOCK}.pid`;
export const DATA_DIR = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local", "share");
export const TRASH_DIR = process.env.RONPI_TRASH ?? path.join(DATA_DIR, "ronpi", "trash");
export const HISTORY_FILE = process.env.RONPI_HISTORY ?? path.join(DATA_DIR, "ronpi", "history.jsonl");
export const LINEAGE_FILE = process.env.RONPI_LINEAGE ?? path.join(DATA_DIR, "ronpi", "lineage.json");
export const SESSION_AGENTS_FILE = process.env.RONPI_SESSION_AGENTS ?? path.join(DATA_DIR, "ronpi", "session-agents.json");
export const HANDLED_FILE = process.env.RONPI_HANDLED ?? path.join(DATA_DIR, "ronpi", "handled-files.json");
export const FEEDBACK_FILE = process.env.RONPI_FEEDBACK ?? path.join(DATA_DIR, "ronpi", "feedback.jsonl");
export const LOG = process.env.RONPI_LOG ?? path.join(import.meta.dirname, "daemon.log");

/**
 * Key/UI debug log, enabled by setting RONPI_KEYS to anything (e.g. 1). It goes
 * to logs/key-debug.log in the repo (git-ignored); a value containing "/" is
 * used as the file path instead. Empty string = off.
 */
function keyLogPath(): string {
  const v = process.env.RONPI_KEYS;
  if (!v) {
    return "";
  }
  if (v.includes("/")) {
    return v;
  }
  const dir = path.join(import.meta.dirname, "..", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "key-debug.log");
}
export const KEY_LOG = keyLogPath();
// The pi that npm installed next to ronpi. The package's exports map hides
// dist/cli.js, so resolve its entry (dist/index.js) and take the sibling.
export const DEFAULT_PI_CLI = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "cli.js",
);

// Extension dialog methods block the child until answered; the rest are
// fire-and-forget (notify/setStatus/setWidget/setTitle/set_editor_text).
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
