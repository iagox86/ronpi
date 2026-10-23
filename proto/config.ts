// Paths and constants shared by the daemon and the controller. Everything is
// derived from the environment at import time, so tests isolate a daemon by
// setting RONPI_SOCK / RONPI_LOG / RONPI_TRASH / XDG_DATA_HOME before spawning.
import * as path from "node:path";

export const SOCK = process.env.RONPI_SOCK ?? `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/ronpi.sock`;
export const PID_FILE = `${SOCK}.pid`;
export const DATA_DIR = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local", "share");
export const TRASH_DIR = process.env.RONPI_TRASH ?? path.join(DATA_DIR, "ronpi", "trash");
export const HISTORY_FILE = process.env.RONPI_HISTORY ?? path.join(DATA_DIR, "ronpi", "history.jsonl");
export const LOG = process.env.RONPI_LOG ?? path.join(import.meta.dirname, "daemon.log");
export const DEFAULT_PI_CLI =
  "/var/home/ron/.nvm/versions/node/v26.12.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

// Extension dialog methods block the child until answered; the rest are
// fire-and-forget (notify/setStatus/setWidget/setTitle/set_editor_text).
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
