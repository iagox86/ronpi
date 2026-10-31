import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clearFile, rewindFile } from "../src/rewind.ts";
import { listTrashedSessions, restoreTrashedSession, trashSessionFile } from "../src/trash.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-trash-"));
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

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-trash-"));
  const sessions = path.join(dir, "sessions", "proj");
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, "2026_abc.jsonl");
  const entries = [
    { type: "session", id: "abc-123", cwd: "/work/proj" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "fix the login bug" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } },
    { type: "session_info", id: "n1", parentId: "a1", name: "Login work" },
  ];
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return { dir, file, trash: path.join(dir, "trash") };
}

describe("deleted sessions", () => {
  it("are listed with what the file says about them, newest first", () => {
    const { file, trash } = setup();
    trashSessionFile(file, trash);
    const [t] = listTrashedSessions(trash);
    assert.equal(t?.originalPath, file);
    assert.equal(t?.sessionId, "abc-123");
    assert.equal(t?.name, "Login work");
    assert.equal(t?.firstMessage, "fix the login bug");
    assert.equal(t?.messages, 2);
    assert.equal(t?.cwd, "/work/proj");
  });

  it("do not include rewind tails or clear backups", () => {
    const { file, trash } = setup();
    clearFile(file, trash);
    fs.appendFileSync(file, `${JSON.stringify({ type: "message", id: "u2", parentId: null, message: { role: "user", content: "again" } })}\n`);
    rewindFile(file, "u2", trash);
    assert.deepEqual(listTrashedSessions(trash), []);
  });

  it("go back where they were deleted from, and leave the trash", () => {
    const { file, trash } = setup();
    const before = fs.readFileSync(file, "utf8");
    const trashed = trashSessionFile(file, trash);
    assert.equal(fs.existsSync(file), false);
    assert.equal(restoreTrashedSession(trashed, trash), file);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(listTrashedSessions(trash), []);
  });

  it("are not restored over a file that is there again, or from outside the trash", () => {
    const { file, trash } = setup();
    const trashed = trashSessionFile(file, trash);
    fs.writeFileSync(file, "new session\n");
    assert.throws(() => restoreTrashedSession(trashed, trash), /already exists/);
    assert.throws(() => restoreTrashedSession(file, trash), /not a file in the trash/);
  });
});
