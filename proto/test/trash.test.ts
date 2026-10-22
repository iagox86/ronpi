import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { trashSessionFile } from "../trash.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-trash-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("trashSessionFile", () => {
  it("moves the file into the trash with a manifest of where it came from", () => {
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, "data");
    const target = trashSessionFile(file, path.join(dir, "trash"));
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(target, "utf8"), "data");
    const manifest = JSON.parse(fs.readFileSync(`${target}.json`, "utf8"));
    assert.equal(manifest.originalPath, file);
    assert.ok(!Number.isNaN(Date.parse(manifest.trashedAt)));
  });

  it("never overwrites an earlier trashed file with the same name", () => {
    const trash = path.join(dir, "trash");
    const first = path.join(dir, "a", "s.jsonl");
    const second = path.join(dir, "b", "s.jsonl");
    fs.mkdirSync(path.dirname(first));
    fs.mkdirSync(path.dirname(second));
    fs.writeFileSync(first, "one");
    fs.writeFileSync(second, "two");
    const t1 = trashSessionFile(first, trash);
    const t2 = trashSessionFile(second, trash);
    assert.notEqual(t1, t2);
    assert.equal(fs.readFileSync(t1, "utf8"), "one");
    assert.equal(fs.readFileSync(t2, "utf8"), "two");
  });

  it("refuses a file that does not exist", () => {
    assert.throws(() => trashSessionFile(path.join(dir, "nope"), dir), /does not exist/);
  });
});
