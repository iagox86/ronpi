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
  /** Sessions parked with /park: session UUID -> when (ms). They show in the oldest colour until used again. */
  parked?: Record<string, number>;
  /** Notes to self by session UUID (/comment): never shown on a row, but searched by the switcher filter. */
  comments?: Record<string, string>;
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
      // park marks used to be stored as `done`; read them under the new name (the next save drops the old key)
      const { done: legacyParked, ...rest } = parsed as Partial<GroupsFile> & { done?: Record<string, number> };
      const parked = parsed.parked ?? legacyParked;
      return { ...rest, groups: merged, assignments: normalized, order: parsed.order, ...(parked ? { parked } : {}) };
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

/** A session is parked from the moment it was marked until its file changes again. */
export function isParked(data: GroupsFile, sessionId: string | undefined, modifiedMs: number): boolean {
  const at = sessionId ? data.parked?.[sessionId] : undefined;
  return at !== undefined && modifiedMs <= at;
}

/** Park or unpark a session (see isParked); returns a new map, leaving `data.parked` untouched. */
export function withParked(data: GroupsFile, sessionId: string, park: boolean, now = Date.now()): Record<string, number> {
  const marks = { ...data.parked };
  if (park) {
    marks[sessionId] = now;
  } else {
    delete marks[sessionId];
  }
  return marks;
}

/** Set a session's comment (empty text removes it); returns a new map, leaving `data.comments` untouched. */
export function withComment(data: GroupsFile, sessionId: string, text: string): Record<string, string> {
  const comments = { ...data.comments };
  const trimmed = text.trim();
  if (trimmed) {
    comments[sessionId] = trimmed;
  } else {
    delete comments[sessionId];
  }
  return comments;
}

/** How long a park mark for a session that no longer exists is kept (a trash restore brings the session back). */
export const PARK_KEEP_MS = 30 * 24 * 3600_000;

/**
 * Drop saved state that points at nothing: fold entries for groups or parent
 * sessions that no longer exist, and park marks for sessions that are gone and were marked long
 * ago. Mutates `data`; returns whether anything was removed.
 */
export function pruneStale(data: GroupsFile, knownSessionIds: ReadonlySet<string>, now = Date.now()): boolean {
  let changed = false;
  if (data.collapsed) {
    // entries are group titles, or the UUID of a folded parent session (kept while that session exists)
    const keep = data.collapsed.filter((entry) => entry === "(ungrouped)" || data.groups.includes(entry) || knownSessionIds.has(entry));
    if (keep.length !== data.collapsed.length) {
      data.collapsed = keep;
      changed = true;
    }
  }
  if (data.parked) {
    for (const [id, at] of Object.entries(data.parked)) {
      if (!knownSessionIds.has(id) && now - at > PARK_KEEP_MS) {
        delete data.parked[id];
        changed = true;
      }
    }
  }
  return changed;
}
