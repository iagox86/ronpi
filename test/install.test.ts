import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { install, removeLegacyLinks } from "../src/install.ts";

function fixture(): { src: string; dest: string } {
  const root = mkdtempSync(join(tmpdir(), "toriel-install-"));
  const src = join(root, "src");
  mkdirSync(join(src, "themes"), { recursive: true });
  mkdirSync(join(src, "extensions"), { recursive: true });
  writeFileSync(join(src, "themes", "t.json"), "{}");
  writeFileSync(join(src, "extensions", "e.ts"), "");
  return { src, dest: join(root, "agent") };
}

describe("install", () => {
  it("links resources into the agent dir and is idempotent", () => {
    const { src, dest } = fixture();
    assert.deepEqual(install(dest, src).map((r) => r.status), ["linked", "linked"]);
    assert.equal(readlinkSync(join(dest, "themes", "t.json")), join(src, "themes", "t.json"));
    assert.deepEqual(install(dest, src).map((r) => r.status), ["ok", "ok"]);
  });

  it("refuses to replace a file that is not its own link", () => {
    const { src, dest } = fixture();
    mkdirSync(join(dest, "themes"), { recursive: true });
    writeFileSync(join(dest, "themes", "t.json"), "mine");
    assert.throws(() => install(dest, src), /already exists/);
    assert.equal(lstatSync(join(dest, "themes", "t.json")).isSymbolicLink(), false);
  });
});

describe("removeLegacyLinks", () => {
  it("removes old-name extension links into the repo and keeps everything else", () => {
    const { src, dest } = fixture();
    mkdirSync(join(dest, "extensions"), { recursive: true });
    const stale = join(dest, "extensions", "ronpi-usage.ts");
    const foreign = join(dest, "extensions", "ronpi-other.ts");
    const unrelated = join(dest, "extensions", "status-bar.ts");
    symlinkSync(join(src, "extensions", "ronpi-usage.ts"), stale);
    symlinkSync("/somewhere/else.ts", foreign);
    symlinkSync(join(src, "extensions", "status-bar.ts"), unrelated);

    assert.deepEqual(removeLegacyLinks(dest, src), [stale]);
    assert.equal(existsSync(stale) || lstatSync(stale, { throwIfNoEntry: false }) !== undefined, false);
    assert.notEqual(lstatSync(foreign, { throwIfNoEntry: false }), undefined);
    assert.notEqual(lstatSync(unrelated, { throwIfNoEntry: false }), undefined);
  });
});
