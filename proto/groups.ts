// Groups storage shared with the stock pi session-groups extension: one JSON
// file at $XDG_DATA_HOME/ronpi/session-groups.json (legacy ~/.pi/agent/
// session-groups.json is still read as a fallback, never written).
// Format: { groups: string[], assignments: { [sessionId]: string | null } }
// null = explicit ungroup (tombstone so fork-inheritance and ungroups stick).
import * as fs from "node:fs";
import * as path from "node:path";

export interface GroupsFile {
  groups: string[];
  assignments: Record<string, string | null>;
  /**
   * Manual display order (session UUIDs, switcher sequence). Sessions not
   * listed sort to the bottom of their section. Optional: absent = no
   * manual ordering yet. Both writers preserve unknown fields so the pi
   * extension and the controller never wipe each other's data.
   */
  order?: string[];
  /** Group titles collapsed in the switcher ("(ungrouped)" included). */
  collapsed?: string[];
  /** Sessions parked with /park (stored as "done"): session UUID -> when (ms). They show in the oldest colour until used again. */
  done?: Record<string, number>;
  /** One-line summaries by session UUID (written by /summarize). */
  summaries?: Record<string, { text: string; messages: number; at: string; model: string }>;
}

export function groupsFile(): string {
  const dataDir = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local", "share");
  return path.join(dataDir, "ronpi", "session-groups.json");
}

function legacyGroupsFile(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent");
  return path.join(agentDir, "session-groups.json");
}

export function loadGroups(): GroupsFile {
  for (const file of [groupsFile(), legacyGroupsFile()]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<GroupsFile>;
      // Self-heal case-insensitive duplicate group names (e.g. legacy
      // "Ron" vs "ron"): first-seen casing wins; assignments remap to it.
      const canonical = new Map<string, string>();
      const merged: string[] = [];
      const canonicalize = (g: string): string => {
        const key = g.toLowerCase();
        let c = canonical.get(key);
        if (c === undefined) {
          c = g;
          canonical.set(key, c);
          merged.push(c);
        }
        return c;
      };
      for (const g of parsed.groups ?? []) {
        canonicalize(g);
      }
      const normalized: Record<string, string | null> = {};
      for (const [id, g] of Object.entries(parsed.assignments ?? {})) {
        normalized[id] = g === null ? null : canonicalize(g);
      }
      // keep fields this code does not know about, so a save never drops another writer's data
      return { ...parsed, groups: merged, assignments: normalized, order: parsed.order };
    } catch {
      // try the next location
    }
  }
  return { groups: [], assignments: {} };
}

export function saveGroups(data: GroupsFile): void {
  // Keep the group list complete: any assigned group must appear in it.
  const seen = new Set(data.groups);
  for (const g of Object.values(data.assignments)) {
    if (g !== null && !seen.has(g)) {
      data.groups.push(g);
      seen.add(g);
    }
  }
  const file = groupsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** Resolve a group name to an existing group (case-insensitive) or append it. */
export function resolveGroup(data: GroupsFile, name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("group name is empty");
  }
  const existing = data.groups.find((g) => g.toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    return existing;
  }
  data.groups.push(trimmed);
  return trimmed;
}

/** A session is done from the moment it was marked until its file changes again. */
export function isDone(data: GroupsFile, sessionId: string | undefined, modifiedMs: number): boolean {
  const at = sessionId ? data.done?.[sessionId] : undefined;
  return at !== undefined && modifiedMs <= at;
}

/** Park or unpark a session (see isDone); returns a new map, leaving `data.done` untouched. */
export function withParked(data: GroupsFile, sessionId: string, parked: boolean, now = Date.now()): Record<string, number> {
  const done = { ...data.done };
  if (parked) {
    done[sessionId] = now;
  } else {
    delete done[sessionId];
  }
  return done;
}
