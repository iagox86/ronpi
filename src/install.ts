// Links toriel's pi-side resources (repo pi/extensions, pi/themes) into pi's
// agent dir: `node install.ts`. Symlinks, so the repo stays the source of truth.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "pi");
const KINDS = ["extensions", "themes", "skills"];

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export interface LinkResult {
  link: string;
  status: "linked" | "ok";
}

/** Link every resource into `dest`. Throws rather than replace anything that is not our link. */
export function install(dest: string, src: string = SRC): LinkResult[] {
  const results: LinkResult[] = [];
  for (const kind of KINDS) {
    const from = join(src, kind);
    if (!existsSync(from)) {
      continue;
    }
    mkdirSync(join(dest, kind), { recursive: true });
    for (const name of readdirSync(from)) {
      const target = join(from, name);
      const link = join(dest, kind, name);
      if (existsSync(link) || isLink(link)) {
        if (isLink(link) && readlinkSync(link) === target) {
          results.push({ link, status: "ok" });
          continue;
        }
        throw new Error(`${link} already exists and is not a link to ${target}; move it aside and rerun`);
      }
      symlinkSync(target, link);
      results.push({ link, status: "linked" });
    }
  }
  return results;
}

const LEGACY_PREFIX = "ronpi-";

/**
 * Remove extension links installed under the project's former name. pi would
 * otherwise load them next to the renamed ones and register everything twice.
 * Only symlinks pointing into `src` are touched.
 */
export function removeLegacyLinks(dest: string, src: string = SRC): string[] {
  const dir = join(dest, "extensions");
  if (!existsSync(dir)) {
    return [];
  }
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const link = join(dir, name);
    if (name.startsWith(LEGACY_PREFIX) && isLink(link) && readlinkSync(link).startsWith(join(src, "extensions"))) {
      unlinkSync(link);
      removed.push(link);
    }
  }
  return removed;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

if (process.argv[1] === import.meta.filename) {
  const dest = agentDir();
  try {
    for (const link of removeLegacyLinks(dest)) {
      console.log(`removed stale link: ${link}`);
    }
    for (const r of install(dest)) {
      console.log(`${r.status === "ok" ? "already linked" : "linked"}: ${r.link}`);
    }
    for (const kind of KINDS) {
      const real = realpathSync(join(dest, kind));
      if (real !== join(dest, kind)) {
        console.log(`note: ${join(dest, kind)} is a symlink; files landed in ${real}`);
      }
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
