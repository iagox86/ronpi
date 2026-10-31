// One-time move of state left under the project's former name. The old name is
// spelled out here and nowhere else in the source, on purpose.
import * as fs from "node:fs";
import * as path from "node:path";

const LEGACY_NAME = "ronpi";
const NAME = "toriel";

export interface Move {
  from: string;
  to: string;
}

export interface MigrationPlan {
  moves: Move[];
  /** Directories present under both names; left alone for the user to merge. */
  conflicts: Move[];
}

/** The config and data dirs, by the same XDG rules config.ts and settings.ts use. */
export function stateDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? "";
  return [env.XDG_CONFIG_HOME ?? path.join(home, ".config"), env.XDG_DATA_HOME ?? path.join(home, ".local", "share")];
}

export function planMigration(roots: string[], exists: (p: string) => boolean): MigrationPlan {
  const plan: MigrationPlan = { moves: [], conflicts: [] };
  for (const root of roots) {
    const move = { from: path.join(root, LEGACY_NAME), to: path.join(root, NAME) };
    if (!exists(move.from)) {
      continue;
    }
    if (exists(move.to)) {
      plan.conflicts.push(move);
    } else {
      plan.moves.push(move);
    }
  }
  return plan;
}

/** Rename legacy dirs into place; returns one line per thing done or skipped. Never deletes or merges. */
export function migrateLegacyState(env: NodeJS.ProcessEnv = process.env): string[] {
  const plan = planMigration(stateDirs(env), fs.existsSync);
  const lines: string[] = [];
  for (const m of plan.moves) {
    try {
      fs.renameSync(m.from, m.to);
      lines.push(`migrated ${m.from} -> ${m.to}`);
    } catch (err) {
      lines.push(`could not move ${m.from} to ${m.to}: ${(err as Error).message}`);
    }
  }
  for (const c of plan.conflicts) {
    lines.push(`both ${c.from} and ${c.to} exist; not migrating, merge ${c.from} by hand`);
  }
  return lines;
}
