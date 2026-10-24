import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { clipThinking, lastThinking, MAX_THINKING_CHARS } from "../why.ts";

function sessionFile(messages: unknown[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "why-")), "s.jsonl");
  fs.writeFileSync(file, messages.map((message) => JSON.stringify({ type: "message", message })).join("\n"));
  return file;
}
const assistant = (...content: unknown[]) => ({ role: "assistant", content });
const thinking = (text: string) => ({ type: "thinking", thinking: text });

describe("lastThinking", () => {
  it("returns the newest assistant message's thinking, joining its blocks", () => {
    const file = sessionFile([
      assistant(thinking("old"), { type: "text", text: "a" }),
      { role: "user", content: "next" },
      assistant(thinking("first"), thinking("second"), { type: "text", text: "b" }),
      assistant({ type: "text", text: "no thinking here" }),
    ]);
    assert.equal(lastThinking(file), "first\n\nsecond");
  });

  it("is undefined when nothing was thought", () => {
    assert.equal(lastThinking(sessionFile([assistant({ type: "text", text: "hi" })])), undefined);
  });
});

describe("clipThinking", () => {
  it("keeps short text and trims long text from the middle", () => {
    assert.equal(clipThinking("short"), "short");
    const clipped = clipThinking(`start${"x".repeat(20_000)}end`);
    assert.ok(clipped.length <= MAX_THINKING_CHARS + 10);
    assert.ok(clipped.startsWith("start") && clipped.endsWith("end") && clipped.includes("[...]"));
  });
});
