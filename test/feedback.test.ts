import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { appendFeedback, formatFeedback, piVersion, readFeedback, torielRevision, sessionPosition } from "../src/feedback.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "toriel-feedback-"));

describe("feedback records", () => {
  it("appends records as lines and reads them back in order, skipping damaged lines", () => {
    const file = path.join(tmp(), "nested", "feedback.jsonl");
    appendFeedback({ at: "2026-10-25T01:00:00Z", source: "user", text: "first" }, file);
    fs.appendFileSync(file, "{torn\n");
    appendFeedback({ at: "2026-10-25T02:00:00Z", source: "agent", text: "second", category: "tool-quirk" }, file);
    assert.deepEqual(readFeedback(file).map((r) => r.text), ["first", "second"]);
  });

  it("reads nothing from a file that does not exist", () => {
    assert.deepEqual(readFeedback(path.join(tmp(), "none.jsonl")), []);
  });

  it("fills in a version and a unique id", () => {
    const file = path.join(tmp(), "f.jsonl");
    appendFeedback({ at: "2026-10-25T01:00:00Z", source: "user", text: "a" }, file);
    appendFeedback({ at: "2026-10-25T01:00:00Z", source: "user", text: "a" }, file);
    const [x, y] = readFeedback(file);
    assert.equal(x?.v, 1);
    assert.notEqual(x?.id, y?.id);
  });

  it("locates the newest entry of a session file: uuid, id, 1-based line and time, ignoring a torn last line", () => {
    const file = path.join(tmp(), "s.jsonl");
    const lines = [
      { type: "session", id: "uuid-1" },
      { type: "message", id: "a", timestamp: "t1" },
      { type: "message", id: "b", timestamp: "t2" },
    ];
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{torn`);
    assert.deepEqual(sessionPosition(file), { sessionId: "uuid-1", entries: 3, entryId: "b", entryLine: 3, entryTimestamp: "t2" });
    assert.equal(sessionPosition(undefined), undefined);
  });

  it("reads versions from a git checkout and a pi install, and shrugs when absent", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), "0123456789abcdef\n");
    assert.equal(torielRevision(root), "0123456789");
    assert.equal(torielRevision(tmp()), undefined);
    const pi = tmp();
    fs.mkdirSync(path.join(pi, "dist"));
    fs.writeFileSync(path.join(pi, "package.json"), '{"version":"1.2.3"}');
    assert.equal(piVersion(path.join(pi, "dist", "cli.js")), "1.2.3");
    assert.equal(piVersion("/nonexistent/dist/cli.js"), undefined);
  });
});

describe("formatFeedback", () => {
  it("shows when, tag, who and what, and says when nothing is recorded", () => {
    assert.match(formatFeedback([]), /no feedback recorded/);
    const text = formatFeedback([
      { at: "2026-10-25T01:02:03Z", source: "agent", text: "skill_manage  lost\nits args", category: "tool-quirk", session: { name: "Mealie" } },
    ]);
    assert.match(text, /2026-10-25 01:02 \[tool-quirk\] \(agent\) - Mealie/);
    assert.match(text, /skill_manage lost its args/);
  });

  it("keeps the newest records and counts the older ones", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ at: "2026-10-25T00:00:00Z", source: "user" as const, text: `n${i}` }));
    const text = formatFeedback(many, 12);
    assert.match(text, /3 older not shown/);
    assert.ok(text.includes("n14") && !text.includes("n2\n"));
  });
});
