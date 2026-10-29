// Pure session-list logic for the switcher: merging daemon sessions with
// session files into rows, ordering them, and the group/order mutations behind
// shift-move and group delete. No I/O, no UI - everything takes plain data.
import * as path from "node:path";
import { fmtAge, firstMessageLabel } from "./format.ts";
import { type GroupsFile, isParked } from "./groups.ts";
import type { SessionMeta } from "./shared.ts";
import type { SessionState, SwitcherSession } from "./switcher.ts";

/** A session known from its file on disk (SessionManager.listAll). */
export interface LocalSession {
  path: string;
  id: string;
  name?: string;
  cwd: string;
  firstMessage: string;
  lastActivity: string;
  model?: string;
  modified: number;
}

/** Canonical key of a daemon session: its file path, else a daemon-local id. */
export function sessionKey(meta: SessionMeta): string {
  return meta.sessionFile ?? `daemon:${meta.id}`;
}

/** Explicit name, else the first message, else "<unnamed>". */
export function displayName(meta: SessionMeta | undefined, info: LocalSession | undefined): string {
  const first = info?.firstMessage ? firstMessageLabel(info.firstMessage, 40) : undefined;
  return meta?.sessionName ?? info?.name ?? first ?? "<unnamed>";
}

export interface ListInputs {
  daemon: Iterable<SessionMeta>;
  local: Map<string, LocalSession>;
  groups: GroupsFile;
  /** Last message text per session key (live descriptions). */
  summaries: Map<string, string>;
  now: number;
}

/**
 * One row per session, from daemon sessions and session files merged by key.
 * An externally-live session pi has not written yet (pseudo entry, no file
 * visible locally) is skipped, so a row never exists without its [pi] tag.
 * Order is local-files-first insertion order; sortSessions() orders for display.
 */
export function buildSessionList(inp: ListInputs): SwitcherSession[] {
  const metaByKey = new Map<string, SessionMeta>();
  for (const meta of inp.daemon) {
    metaByKey.set(sessionKey(meta), meta);
  }
  const keys = new Set<string>([...inp.local.keys(), ...metaByKey.keys()]);
  const list: SwitcherSession[] = [];
  for (const key of keys) {
    const meta = metaByKey.get(key);
    const info = inp.local.get(key);
    if (meta && meta.id < 0 && !info) {
      continue;
    }
    const cwd = meta?.cwd ?? info?.cwd ?? (key.startsWith("daemon:") ? key : path.dirname(key));
    const explicitName = meta?.sessionName ?? info?.name;
    const first = info?.firstMessage ? firstMessageLabel(info.firstMessage, 40) : undefined;
    let state: SessionState = "inactive";
    if (meta?.active) {
      state = meta.streaming ? "streaming" : meta.dead ? "dead" : "idle";
    }
    const sessionId = meta?.sessionId ?? info?.id;
    const group = sessionId ? (inp.groups.assignments[sessionId] ?? undefined) : undefined;
    let note: string | undefined;
    if (meta?.pendingDialog) {
      note = "waiting on permission";
    } else if (meta?.externallyLive) {
      note = "live in pi - /adopt to fork";
    } else if (meta?.attachedElsewhere) {
      note = "view-only";
    } else if (state === "dead") {
      note = "crashed - prompt respawns";
    }
    const modified = info?.modified ?? 0;
    list.push({
      key,
      // Unnamed sessions show their first message as the name; the project
      // (cwd basename) moves to the description column.
      name: displayName(meta, info),
      group,
      state,
      muted: !!meta?.externallyLive,
      daemonId: meta?.id,
      sessionId,
      cwd,
      note,
      comment: sessionId ? inp.groups.comments?.[sessionId] : undefined,
      age: fmtAge(modified > 0 ? inp.now - modified : 0),
      // parked sessions take the oldest colour whatever their real age
      ageMs: modified > 0 && !isParked(inp.groups, sessionId, modified) ? inp.now - modified : undefined,
      parked: isParked(inp.groups, sessionId, modified),
      model: meta?.model ? meta.model.split("/").pop() : info?.model,
      description:
        note ||
        (sessionId ? inp.groups.summaries?.[sessionId]?.text : undefined) ||
        inp.summaries.get(key) ||
        info?.lastActivity ||
        (explicitName ? (first ?? path.basename(cwd)) : path.basename(cwd)),
    });
  }
  return list;
}

/**
 * Display order: the persisted manual order (groups.json `order`) first, then
 * sessions never manually placed, in `openedOrder` (captured when the switcher
 * opened and frozen, so background file activity elsewhere never reshuffles
 * the list under the cursor). Sorts in place.
 */
export function sortSessions(list: SwitcherSession[], manualOrder: string[], openedOrder: string[]): void {
  const manual = new Map(manualOrder.map((k, i) => [k, i]));
  const opened = new Map(openedOrder.map((k, i) => [k, i]));
  list.sort((a, b) => {
    let ra = a.sessionId !== undefined ? manual.get(a.sessionId) : undefined;
    let rb = b.sessionId !== undefined ? manual.get(b.sessionId) : undefined;
    if (ra !== undefined || rb !== undefined) {
      ra = ra ?? Number.MAX_SAFE_INTEGER;
      rb = rb ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) {
        return ra - rb;
      }
    }
    const oa = opened.get(a.key) ?? Number.MAX_SAFE_INTEGER;
    const ob = opened.get(b.key) ?? Number.MAX_SAFE_INTEGER;
    return oa !== ob ? oa - ob : a.key.localeCompare(b.key);
  });
}

/**
 * Sessions the manual order does not know yet (new ones; on first run, all of
 * them) are appended in display order, so a new session lands at the bottom
 * instead of wherever file recency would put it. Returns the new order, or
 * null when nothing was missing.
 */
export function appendUnranked(order: string[] | undefined, displayed: SwitcherSession[]): string[] | null {
  const known = new Set(order ?? []);
  const missing = displayed.flatMap((s) => (s.sessionId !== undefined && !known.has(s.sessionId) ? [s.sessionId] : []));
  return missing.length === 0 ? null : [...(order ?? []), ...missing];
}

export interface MutationResult {
  changed: boolean;
  /** Message for the switcher hint line. */
  hint?: string;
}

/**
 * shift+up/down on a session row: swap within its section, or cross into the
 * adjacent section (reassigning its group). Mutates `groups.order` and
 * `groups.assignments`; `sessions` is the displayed list.
 */
export function moveSession(groups: GroupsFile, sessions: SwitcherSession[], s: SwitcherSession, delta: number): MutationResult {
  const uuid = s.sessionId;
  if (uuid === undefined) {
    return { changed: false };
  }
  if ((s.depth ?? 0) > 0) {
    return { changed: false, hint: "move the parent instead - children stay under it" };
  }
  // A parent moves with everything below it: only top-level sessions are placed, descendants follow.
  const below = new Map<string, string[]>();
  let owner: string | undefined;
  for (const x of sessions) {
    if (x.sessionId === undefined) {
      continue;
    }
    if ((x.depth ?? 0) === 0) {
      owner = x.sessionId;
    } else if (owner !== undefined) {
      below.set(owner, [...(below.get(owner) ?? []), x.sessionId]);
    }
  }
  // Section structure INCLUDING empty groups: [ungrouped, ...groups]. Moves
  // are section-relative, so an empty group is a valid target (the moved
  // session becomes its only member).
  const sections: Array<{ group: string | null; uuids: string[] }> = [{ group: null, uuids: [] }];
  for (const g of groups.groups) {
    sections.push({ group: g, uuids: [] });
  }
  const sectionIndex = (group: string | null) => (group === null ? 0 : 1 + groups.groups.indexOf(group));
  for (const x of sessions) {
    if (x.sessionId !== undefined && (x.depth ?? 0) === 0) {
      sections[sectionIndex(x.group ?? null)].uuids.push(x.sessionId);
    }
  }
  const secIdx = sectionIndex(s.group ?? null);
  const section = sections[secIdx];
  const pos = section.uuids.indexOf(uuid);
  if (pos === -1) {
    return { changed: false };
  }
  const step = delta > 0 ? 1 : -1;
  const neighbor = section.uuids[pos + step];
  const adjacent = sections[secIdx + step];
  if (neighbor !== undefined) {
    section.uuids[pos + step] = uuid;
    section.uuids[pos] = neighbor;
  } else if (adjacent) {
    // edge of the section: first of the next / last of the previous one
    section.uuids.splice(pos, 1);
    if (step > 0) {
      adjacent.uuids.unshift(uuid);
    } else {
      adjacent.uuids.push(uuid);
    }
    groups.assignments[uuid] = adjacent.group;
    for (const kid of below.get(uuid) ?? []) {
      groups.assignments[kid] = adjacent.group;
    }
  } else {
    return { changed: false, hint: step > 0 ? "already at the bottom" : "already at the top" };
  }
  groups.order = sections.flatMap((sec) => sec.uuids.flatMap((id) => [id, ...(below.get(id) ?? [])]));
  return { changed: true };
}

/** shift+up/down on a group header: swap with the neighboring group. */
export function moveGroup(groups: GroupsFile, title: string, delta: number): MutationResult {
  const gs = groups.groups;
  const i = gs.indexOf(title);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= gs.length) {
    return { changed: false, hint: delta < 0 ? "already the first group" : "already the last group" };
  }
  gs[i] = gs[j];
  gs[j] = title;
  return { changed: true };
}

/** ctrl-x on a group header: delete it, but only when no session is in it. */
export function deleteEmptyGroup(groups: GroupsFile, sessions: SwitcherSession[], title: string): MutationResult {
  if (title === "(ungrouped)") {
    return { changed: false, hint: "(ungrouped) can't be deleted" };
  }
  const count = sessions.filter((x) => x.group === title).length;
  if (count > 0) {
    return { changed: false, hint: `${title} has ${count} session${count === 1 ? "" : "s"} - move them out first` };
  }
  const i = groups.groups.indexOf(title);
  if (i !== -1) {
    groups.groups.splice(i, 1);
    // Purge stale assignments (e.g. from trashed sessions) - saveGroups
    // resurrects any group an assignment still references.
    for (const [id, g] of Object.entries(groups.assignments)) {
      if (g === title) {
        groups.assignments[id] = null;
      }
    }
  }
  return { changed: true, hint: `group ${title} deleted` };
}

/** One line for a collapsed group: how many sessions, what they are doing, how recent the newest is. */
export function groupTldr(list: SwitcherSession[]): string {
  if (list.length === 0) {
    return "empty";
  }
  const count = (state: SwitcherSession["state"]) => list.filter((s) => s.state === state).length;
  const parts = [`${list.length} session${list.length === 1 ? "" : "s"}`];
  const states: Array<[SwitcherSession["state"], string]> = [
    ["streaming", "working"],
    ["idle", "idle"],
    ["dead", "crashed"],
  ];
  for (const [state, label] of states) {
    if (count(state) > 0) {
      parts.push(`${count(state)} ${label}`);
    }
  }
  const newest = list.filter((s) => s.ageMs !== undefined).sort((a, b) => (a.ageMs as number) - (b.ageMs as number))[0];
  if (newest) {
    parts.push(`newest ${newest.age}`);
  }
  return parts.join(" - ");
}
