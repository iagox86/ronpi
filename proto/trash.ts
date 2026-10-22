// Deletes never unlink: the session file is the only copy of a session, so it
// moves to the trash dir with a manifest (original path + timestamp) that a
// future /restore can read.
import * as fs from "node:fs";
import * as path from "node:path";

/** Move `file` into `trashDir`; returns the new location. */
export function trashSessionFile(file: string, trashDir: string): string {
  if (!fs.existsSync(file)) {
    throw new Error(`session file does not exist: ${file}`);
  }
  fs.mkdirSync(trashDir, { recursive: true });
  const base = path.basename(file);
  let target = path.join(trashDir, base);
  if (fs.existsSync(target)) {
    target = path.join(trashDir, `${Date.now()}-${base}`);
  }
  fs.renameSync(file, target);
  fs.writeFileSync(
    `${target}.json`,
    `${JSON.stringify({ originalPath: file, trashedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return target;
}
