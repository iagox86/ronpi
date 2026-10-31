import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { recordHandled, wasHandled } from "../src/handled-files.ts";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-handled-")), "sub", "handled.json");

describe("handled files", () => {
  it("remembers a recorded file, and only that one", () => {
    const f = tmp();
    assert.equal(wasHandled("/a.jsonl", f), false);
    recordHandled("/a.jsonl", f);
    recordHandled("/a.jsonl", f);
    assert.equal(wasHandled("/a.jsonl", f), true);
    assert.equal(wasHandled("/b.jsonl", f), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), ["/a.jsonl"]);
  });

  it("treats a corrupt record as empty instead of failing", () => {
    const f = tmp();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "{not json");
    assert.equal(wasHandled("/a.jsonl", f), false);
    recordHandled("/a.jsonl", f);
    assert.equal(wasHandled("/a.jsonl", f), true);
  });
});
