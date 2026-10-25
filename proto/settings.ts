// ronpi's own settings file (~/.config/ronpi/settings.json). Layers, lowest
// first: built-in defaults, this file, RONPI_* environment variables (which
// tests and smoke runs use to isolate a daemon). The daemon reads it each time
// it starts a child, so a change applies to new and respawned sessions without
// a restart; its mtime tells the switcher which running sessions are behind.
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_PI_CLI } from "./config.ts";

export type SteeringMode = "all" | "one-at-a-time";

export interface RonpiSettings {
  /** How messages sent mid-run are delivered (default "all"). */
  steeringMode?: SteeringMode;
  /** Default provider / model / thinking level for sessions ronpi starts. */
  provider?: string;
  model?: string;
  thinking?: string;
  /** Path of pi's cli.js. */
  piCli?: string;
  /** Model /summarize uses (provider/id); default litellm/gemma4:12b. */
  summaryModel?: string;
  /** Re-summarize changed sessions this often while ronpi is open (default 60; 0 = never). */
  summaryIntervalMinutes?: number;
  /** A summary is refreshed once its session has this many new messages (default 6). */
  summaryMinNewMessages?: number;
}

export interface LoadedSettings {
  settings: RonpiSettings;
  /** Problems found (unreadable JSON, wrong types, unknown keys); the rest still applies. */
  problems: string[];
}

export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RONPI_SETTINGS) {
    return env.RONPI_SETTINGS;
  }
  const config = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? "", ".config");
  return path.join(config, "ronpi", "settings.json");
}

/** Modification time of the settings file; null when it does not exist. */
export function settingsMtime(file: string = settingsFile()): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

const NUMBER_KEYS = ["summaryIntervalMinutes", "summaryMinNewMessages"] as const;
const STRING_KEYS = ["provider", "model", "thinking", "piCli", "summaryModel"] as const;

export function loadSettings(file: string = settingsFile()): LoadedSettings {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { settings: {}, problems: [] }; // no file is normal
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { settings: {}, problems: [`${file}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { settings: {}, problems: [`${file}: expected a JSON object`] };
  }
  const obj = json as Record<string, unknown>;
  const settings: RonpiSettings = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === "steeringMode") {
      if (value === "all" || value === "one-at-a-time") {
        settings.steeringMode = value;
      } else {
        problems.push(`steeringMode must be "all" or "one-at-a-time"`);
      }
    } else if ((STRING_KEYS as readonly string[]).includes(key)) {
      if (typeof value === "string" && value.length > 0) {
        settings[key as (typeof STRING_KEYS)[number]] = value;
      } else {
        problems.push(`${key} must be a non-empty string`);
      }
    } else if ((NUMBER_KEYS as readonly string[]).includes(key)) {
      // the interval may be 0 (off); the other counts must be positive
      const min = key === "summaryIntervalMinutes" ? 0 : 1;
      if (typeof value === "number" && Number.isFinite(value) && value >= min) {
        settings[key as (typeof NUMBER_KEYS)[number]] = value;
      } else {
        problems.push(`${key} must be a number${min === 0 ? " (0 turns it off)" : " of at least 1"}`);
      }
    } else {
      problems.push(`unknown setting "${key}"`);
    }
  }
  return { settings, problems };
}

export interface ChildConfig {
  steeringMode: SteeringMode;
  provider?: string;
  model?: string;
  thinking?: string;
  piCli: string;
}

/** Defaults < file < environment. */
export function resolveChildConfig(s: RonpiSettings, env: NodeJS.ProcessEnv = process.env): ChildConfig {
  const mode = env.RONPI_STEERING_MODE ?? s.steeringMode;
  return {
    steeringMode: mode === "one-at-a-time" ? "one-at-a-time" : "all",
    provider: env.RONPI_PROVIDER ?? s.provider,
    model: env.RONPI_MODEL ?? s.model,
    thinking: env.RONPI_THINKING ?? s.thinking,
    piCli: env.RONPI_PI_CLI ?? s.piCli ?? DEFAULT_PI_CLI,
  };
}
