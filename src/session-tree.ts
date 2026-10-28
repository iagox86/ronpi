// Parent/child sessions in the switcher: forks now, subagents later. Pure:
// a sorted list and a child->parent map in, a list where every child sits
// right under its parent (indented, in the parent's group) out.
import type { Lineage } from "./lineage.ts";
import type { SwitcherSession } from "./switcher.ts";

/** What the tree adds to a row. */
export interface TreeFields {
  /** Nesting level; 0 for a top-level session. */
  depth: number;
  /** UUID of the parent, when it is in the list. */
  parentId?: string;
  /** All sessions below this one. */
  descendants: number;
  /** Of those, how many are working right now. */
  descendantsWorking: number;
  /** Of those, how many were parked (hidden unless a filter is on). */
  descendantsParked: number;
}

/**
 * Nest `list` (already in display order) under the parents named in `parentOf`.
 * A session whose parent is not in the list, or that would make a cycle, stays
 * top-level. Children keep their relative order and take their top-level
 * ancestor's group. Mutates the rows (depth, group and counts) and returns the
 * new order.
 */
export function arrangeTree(list: SwitcherSession[], parentOf: ReadonlyMap<string, string>): SwitcherSession[] {
  const byUuid = new Map<string, SwitcherSession>();
  for (const s of list) {
    if (s.sessionId) {
      byUuid.set(s.sessionId, s);
    }
  }
  const parentRow = (s: SwitcherSession): SwitcherSession | undefined => {
    const p = s.sessionId ? parentOf.get(s.sessionId) : undefined;
    const row = p ? byUuid.get(p) : undefined;
    return row === s ? undefined : row;
  };
  // drop links that lead into a cycle
  const hasCycle = (s: SwitcherSession): boolean => {
    const seen = new Set<SwitcherSession>([s]);
    for (let p = parentRow(s); p; p = parentRow(p)) {
      if (seen.has(p)) {
        return true;
      }
      seen.add(p);
    }
    return false;
  };
  const children = new Map<SwitcherSession, SwitcherSession[]>();
  const roots: SwitcherSession[] = [];
  for (const s of list) {
    const p = hasCycle(s) ? undefined : parentRow(s);
    if (p) {
      children.set(p, [...(children.get(p) ?? []), s]);
    } else {
      roots.push(s);
    }
  }
  const out: SwitcherSession[] = [];
  const visit = (s: SwitcherSession, depth: number, root: SwitcherSession, parent?: SwitcherSession): void => {
    s.depth = depth;
    s.parentId = parent?.sessionId;
    s.group = root.group;
    out.push(s);
    const kids = children.get(s) ?? [];
    const before = out.length;
    for (const k of kids) {
      visit(k, depth + 1, root, s);
    }
    const below = out.slice(before);
    s.descendants = below.length;
    s.descendantsWorking = below.filter((x) => x.state === "streaming").length;
    s.descendantsParked = below.filter((x) => x.parked).length;
  };
  for (const r of roots) {
    visit(r, 0, r);
  }
  return out;
}

/** "3 children, 1 working, 1 parked" for a parent's row; empty for a session with none. */
export function childNote(s: SwitcherSession): string {
  const n = s.descendants ?? 0;
  if (n === 0) {
    return "";
  }
  const parts = [`${n} ${n === 1 ? "child" : "children"}`];
  if (s.descendantsWorking) {
    parts.push(`${s.descendantsWorking} working`);
  }
  if (s.descendantsParked) {
    parts.push(`${s.descendantsParked} parked`);
  }
  return parts.join(", ");
}

/**
 * Which rows to show: everything below a folded session goes, and so do parked
 * children unless a filter is on (the filter is how they are found again).
 */
export function visibleRows(ordered: readonly SwitcherSession[], folded: ReadonlySet<string>, filterOn: boolean): SwitcherSession[] {
  const out: SwitcherSession[] = [];
  let hideBelow: number | null = null; // depth of the folded/hidden session whose subtree is being skipped
  for (const s of ordered) {
    const depth = s.depth ?? 0;
    if (hideBelow !== null) {
      if (depth > hideBelow) {
        continue;
      }
      hideBelow = null;
    }
    if (depth > 0 && s.parked && !filterOn) {
      hideBelow = depth;
      continue;
    }
    out.push(s);
    if (!filterOn && s.sessionId && folded.has(s.sessionId) && (s.descendants ?? 0) > 0) {
      hideBelow = depth;
    }
  }
  return out;
}

/** How a viewed session relates to its parent, for the banner. */
export interface Relation {
  kind: "subagent";
  parentId: string;
  /** The name the lineage file recorded for the parent; the live name is better when known. */
  parentName: string;
}

export function relationOf(lineage: Lineage, uuid: string | undefined): Relation | undefined {
  const entry = uuid ? lineage[uuid] : undefined;
  // only agent-started sessions are shown as children; a user's fork is a session of its own
  return entry?.parent && entry.kind === "subagent" ? { kind: "subagent", parentId: entry.parent.id, parentName: entry.parent.name } : undefined;
}

/** Every session below `uuid` (children, their children...), cycle-safe. */
export function descendantIds(lineage: Lineage, uuid: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([uuid]);
  const queue = [uuid];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const f of lineage[id]?.forks ?? []) {
      if (lineage[f.id]?.kind === "subagent" && !seen.has(f.id)) {
        seen.add(f.id);
        out.push(f.id);
        queue.push(f.id);
      }
    }
  }
  return out;
}

/** Spend of everything below `uuid`. */
export function childCost(lineage: Lineage, uuid: string | undefined, costOf: (id: string) => number): number {
  return uuid ? descendantIds(lineage, uuid).reduce((sum, id) => sum + costOf(id), 0) : 0;
}

/** The banner line shown above the chat box while viewing a child. */
export function bannerText(rel: Relation, parentName: string): string {
  return `SUBAGENT of ${parentName}  -  /parent jumps to the parent, /detach cuts the link, left goes back`;
}
