// Imported first by the daemon and controller entry points, so legacy state is
// moved before anything reads it. Imports nothing from config.ts on purpose.
import { migrateLegacyState } from "./migrate.ts";

for (const line of migrateLegacyState()) {
  process.stderr.write(`toriel: ${line}\n`);
}
