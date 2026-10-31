import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { migrateLegacyState, planMigration, stateDirs } from "../src/migrate.ts";

describe("planMigration", () => {
  it("moves a legacy dir that has no replacement", () => {
    const plan = planMigration(["/c", "/d"], (p) => p === "/c/ronpi" || p === "/d/ronpi");
    assert.deepEqual(plan.moves, [
      { from: "/c/ronpi", to: "/c/toriel" },
      { from: "/d/ronpi", to: "/d/toriel" },
    ]);
    assert.deepEqual(plan.conflicts, []);
  });

  it("reports a conflict instead of merging when both names exist", () => {
    const plan = planMigration(["/c"], () => true);
    assert.deepEqual(plan.moves, []);
    assert.deepEqual(plan.conflicts, [{ from: "/c/ronpi", to: "/c/toriel" }]);
  });

  it("does nothing on a fresh install", () => {
    assert.deepEqual(planMigration(["/c"], () => false), { moves: [], conflicts: [] });
  });
});

describe("stateDirs", () => {
  it("follows the XDG variables and falls back to HOME", () => {
    assert.deepEqual(stateDirs({ HOME: "/h" }), ["/h/.config", "/h/.local/share"]);
    assert.deepEqual(stateDirs({ HOME: "/h", XDG_CONFIG_HOME: "/x", XDG_DATA_HOME: "/y" }), ["/x", "/y"]);
  });
});

describe("migrateLegacyState", () => {
  it("renames the legacy dirs with their contents, then is a no-op", () => {
    const root = mkdtempSync(join(tmpdir(), "toriel-migrate-"));
    const env = { HOME: root, XDG_CONFIG_HOME: join(root, "cfg"), XDG_DATA_HOME: join(root, "data") };
    mkdirSync(join(root, "cfg", "ronpi"), { recursive: true });
    writeFileSync(join(root, "cfg", "ronpi", "settings.json"), "{}");
    mkdirSync(join(root, "data", "toriel"), { recursive: true });

    const first = migrateLegacyState(env);
    assert.equal(first.length, 1);
    assert.equal(readFileSync(join(root, "cfg", "toriel", "settings.json"), "utf8"), "{}");
    assert.equal(existsSync(join(root, "cfg", "ronpi")), false);
    assert.deepEqual(migrateLegacyState(env), []);
  });
});
