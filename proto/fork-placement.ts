// Where a fork lands in the switcher: right below its parent, same group.
import type { GroupsFile } from "./groups.ts";

/** Marks a fork in its display name (single-width; the emoji variant is wide and font-dependent). */
export const FORK_MARK = "⑂";

/** `⑂ <parent name>`; a fork of a fork keeps one mark. */
export function forkName(parentName: string): string {
  return `${FORK_MARK} ${parentName.replace(new RegExp(`^${FORK_MARK}\\s*`), "")}`;
}

/** Insert `forkId` straight after `parentId` in the manual order and copy the parent's group. */
export function placeFork(groups: GroupsFile, parentId: string, forkId: string): void {
  const order = (groups.order ?? []).filter((id) => id !== forkId);
  let at = order.indexOf(parentId);
  if (at === -1) {
    order.push(parentId);
    at = order.length - 1;
  }
  order.splice(at + 1, 0, forkId);
  groups.order = order;
  if (parentId in groups.assignments) {
    groups.assignments[forkId] = groups.assignments[parentId] ?? null;
  }
}
