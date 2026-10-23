import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { rewindFile, rewindTargets } from "../rewind.ts";

function session(): { file: string; trash: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-rewind-"));
  const file = path.join(dir, "s.jsonl");
  const entries = [
    { type: "session", id: "sid", version: 3 },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "first" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
    { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: [{ type: "text", text: "second" }] } },
    { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
  ];
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return { file, trash: path.join(dir, "trash") };
}

const ids = (file: string) =>
  fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id);

describe("rewind", () => {
  it("lists user messages, oldest first, skipping assistant entries", () => {
    const { file } = session();
    assert.deepEqual(rewindTargets(file), [
      { entryId: "u1", text: "first", ts: 0 },
      { entryId: "u2", text: "second", ts: 0 },
    ]);
  });

  it("cuts the session back to before the chosen message and returns its text", () => {
    const { file, trash } = session();
    const r = rewindFile(file, "u2", trash);
    assert.deepEqual(ids(file), ["sid", "u1", "a1"]);
    assert.equal(r.text, "second");
    assert.equal(r.removed, 2);
  });

  it("keeps the removed tail in the trash with a manifest", () => {
    const { file, trash } = session();
    const r = rewindFile(file, "u2", trash);
    assert.deepEqual(ids(r.trashedTo), ["u2", "a2"]);
    const manifest = JSON.parse(fs.readFileSync(`${r.trashedTo}.json`, "utf8"));
    assert.equal(manifest.originalPath, file);
    assert.equal(manifest.rewoundBeforeEntry, "u2");
  });

  it("can rewind to the very first message, leaving only the header", () => {
    const { file, trash } = session();
    rewindFile(file, "u1", trash);
    assert.deepEqual(ids(file), ["sid"]);
  });

  it("refuses an unknown or non-user entry and leaves the file alone", () => {
    const { file, trash } = session();
    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => rewindFile(file, "a1", trash), /no user message/);
    assert.throws(() => rewindFile(file, "nope", trash), /no user message/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});
