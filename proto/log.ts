import * as fs from "node:fs";
import { LOG } from "./config.ts";

export function log(msg: string): void {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // logging must never take the daemon down
  }
}
