// Paths and constants shared by the daemon and the controller. Everything is
// derived from the environment at import time, so tests isolate a daemon by
// setting RONPI_SOCK / RONPI_LOG / RONPI_TRASH / XDG_DATA_HOME before spawning.
import * as fs from "node:fs";
import * as path from "node:path";

export const SOCK = process.env.RONPI_SOCK ?? `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/ronpi.sock`;
export const PID_FILE = `${SOCK}.pid`;
export const DATA_DIR = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local", "share");
export const TRASH_DIR = process.env.RONPI_TRASH ?? path.join(DATA_DIR, "ronpi", "trash");
export const HISTORY_FILE = process.env.RONPI_HISTORY ?? path.join(DATA_DIR, "ronpi", "history.jsonl");
export const LINEAGE_FILE = process.env.RONPI_LINEAGE ?? path.join(DATA_DIR, "ronpi", "lineage.json");
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
export const DEFAULT_PI_CLI =
  "/var/home/ron/.nvm/versions/node/v26.12.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

// Extension dialog methods block the child until answered; the rest are
// fire-and-forget (notify/setStatus/setWidget/setTitle/set_editor_text).
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
