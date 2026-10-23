// The few pi settings (~/.pi/agent/settings.json) that ronpi's own rendering
// should honor, since pi's components don't read them for us. Read once at
// startup; a missing or unreadable file means defaults.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type WheelScrollLines = "auto" | number;

function load(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Lines per mouse-wheel event; pi's default "auto" accelerates fast spins. */
export function wheelScrollLines(settings: Record<string, unknown> = load()): WheelScrollLines {
  const v = settings.fullscreenWheelScrollLines;
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100) {
    return v;
  }
  return "auto";
}
