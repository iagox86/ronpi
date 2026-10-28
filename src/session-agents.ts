// Which agent profile a session was started with. A respawn (`--session file`)
// loses launch flags, so the resolved profile is saved here, keyed by session
// UUID, and re-applied every time that session's pi process starts. It is a
// snapshot: editing the agent file later does not change running history.
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentProfile } from "./agents.ts";
import { SESSION_AGENTS_FILE } from "./config.ts";

export type SessionAgents = Record<string, AgentProfile>;

export function loadSessionAgents(file = SESSION_AGENTS_FILE): SessionAgents {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SessionAgents;
  } catch {
    return {};
  }
}

export function profileOfSession(sessionId: string | undefined, file = SESSION_AGENTS_FILE): AgentProfile | undefined {
  return sessionId ? loadSessionAgents(file)[sessionId] : undefined;
}

export function saveSessionAgent(sessionId: string, profile: AgentProfile, file = SESSION_AGENTS_FILE): void {
  const data = loadSessionAgents(file);
  data[sessionId] = profile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}
