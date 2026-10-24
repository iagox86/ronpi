import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { clearFile, latestClearBackup, restoreClear, rewindFile, rewindTargets } from "../rewind.ts";

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

describe("clearFile", () => {
  function named(): { file: string; trash: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-clear-"));
    const file = path.join(dir, "s.jsonl");
    const entries = [
      { type: "session", id: "sid", version: 3 },
      { type: "model_change", id: "m1", parentId: null, modelId: "old" },
      { type: "message", id: "u1", parentId: "m1", message: { role: "user", content: "first" } },
      { type: "model_change", id: "m2", parentId: "u1", modelId: "new" },
      { type: "message", id: "a1", parentId: "m2", message: { role: "assistant", content: [] } },
      { type: "session_info", id: "n1", parentId: "a1", name: "my session" },
    ];
    fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
    return { file, trash: path.join(dir, "trash") };
  }

  it("drops every message but keeps the header, latest model and name in one chain", () => {
    const { file, trash } = named();
    clearFile(file, trash);
    const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(entries.map((e) => e.type), ["session", "model_change", "session_info"]);
    assert.equal(entries[1].modelId, "new");
    assert.equal(entries[1].parentId, null);
    assert.equal(entries[2].parentId, "m2");
    assert.equal(entries[2].name, "my session");
    assert.deepEqual(rewindTargets(file), []);
  });

  it("copies the whole previous file to the trash first", () => {
    const { file, trash } = named();
    const before = fs.readFileSync(file, "utf8");
    const r = clearFile(file, trash);
    assert.equal(fs.readFileSync(r.trashedTo, "utf8"), before);
    assert.ok(fs.existsSync(`${r.trashedTo}.json`));
  });
});

describe("undoing a clear", () => {
  function cleared(): { file: string; trash: string; before: string } {
    const { file, trash } = session();
    const before = fs.readFileSync(file, "utf8");
    clearFile(file, trash);
    return { file, trash, before };
  }

  it("finds the backup of a cleared file and puts the old contents back", () => {
    const { file, trash, before } = cleared();
    assert.deepEqual(rewindTargets(file), []);
    const backup = latestClearBackup(trash, file);
    assert.ok(backup);
    restoreClear(file, backup);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  it("offers a backup only once", () => {
    const { file, trash } = cleared();
    restoreClear(file, latestClearBackup(trash, file)!);
    assert.equal(latestClearBackup(trash, file), undefined);
  });

  it("offers the newest of several clears, and nothing for another file", () => {
    const { file, trash } = cleared();
    fs.appendFileSync(file, `${JSON.stringify({ type: "message", id: "u9", parentId: null, message: { role: "user", content: "later" } })}\n`);
    clearFile(file, trash, new Date(Date.now() + 60_000));
    const newest = latestClearBackup(trash, file);
    assert.match(fs.readFileSync(newest!.trashedTo, "utf8"), /later/);
    assert.equal(latestClearBackup(trash, "/elsewhere.jsonl"), undefined);
  });
});

describe("rewind targets around a compaction", () => {
  it("flags the messages that a compaction came after, so rewinding there is known to undo it", () => {
    const { file } = session();
    fs.appendFileSync(file, `${JSON.stringify({ type: "compaction", id: "k", summary: "s", firstKeptEntryId: "u2", tokensBefore: 1 })}\n`);
    fs.appendFileSync(file, `${JSON.stringify({ type: "message", id: "u3", parentId: "k", message: { role: "user", content: "after" } })}\n`);
    const flags = rewindTargets(file).map((t) => Boolean(t.compacted));
    assert.deepEqual(flags, [true, true, false]);
  });

  it("flags nothing in a session that was never compacted", () => {
    assert.ok(rewindTargets(session().file).every((t) => !t.compacted));
  });
});
