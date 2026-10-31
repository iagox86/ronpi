import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { loadCommands, mergeHistory, recordCommand, trimCommands } from "../src/history.ts";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-hist-")), "sub", "history.jsonl");

describe("command log", () => {
  it("records commands and reads them back oldest first", () => {
    const f = tmpFile();
    recordCommand(f, "/new", 1);
    recordCommand(f, "/group work", 2);
    assert.deepEqual(loadCommands(f), [
      { ts: 1, text: "/new" },
      { ts: 2, text: "/group work" },
    ]);
  });

  it("treats a missing file as empty and skips torn lines", () => {
    const f = tmpFile();
    assert.deepEqual(loadCommands(f), []);
    recordCommand(f, "/ok", 1);
    fs.appendFileSync(f, '{"ts": 2, "te');
    assert.deepEqual(loadCommands(f).map((e) => e.text), ["/ok"]);
  });

  it("trims to the newest entries", () => {
    const f = tmpFile();
    for (let i = 1; i <= 5; i++) {
      recordCommand(f, `/c${i}`, i);
    }
    trimCommands(f, 2);
    assert.deepEqual(loadCommands(f).map((e) => e.text), ["/c4", "/c5"]);
  });
});

describe("mergeHistory", () => {
  it("interleaves prompts and commands by time", () => {
    const out = mergeHistory(
      [{ ts: 10, text: "first prompt" }, { ts: 30, text: "second prompt" }],
      [{ ts: 20, text: "/new" }],
    );
    assert.deepEqual(out, ["first prompt", "/new", "second prompt"]);
  });

  it("drops a command that pi also recorded as a prompt moments apart", () => {
    const out = mergeHistory([{ ts: 1000, text: "/compact" }], [{ ts: 1500, text: "/compact" }]);
    assert.deepEqual(out, ["/compact"]);
  });

  it("keeps the same command typed again much later", () => {
    const out = mergeHistory([{ ts: 1000, text: "/compact" }], [{ ts: 900_000, text: "/compact" }]);
    assert.deepEqual(out, ["/compact", "/compact"]);
  });
});
