import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { applyDelta, applyEvent, type AssistantItem, type Item, messagesFromFile, newView } from "../transcript.ts";

function assistant(content: unknown[] = []): AssistantItem {
  return { kind: "assistant", component: undefined as never, partial: { content }, text: new Map(), thinking: new Map() };
}

describe("applyDelta", () => {
  it("accumulates streamed text into the partial message", () => {
    const item = assistant();
    applyDelta(item, { type: "text_delta", contentIndex: 0, delta: "Hel" });
    applyDelta(item, { type: "text_delta", contentIndex: 0, delta: "lo" });
    assert.deepEqual(item.partial.content, [{ type: "text", text: "Hello" }]);
  });

  it("keeps text and thinking blocks at their own indexes", () => {
    const item = assistant();
    applyDelta(item, { type: "thinking_delta", contentIndex: 0, delta: "hmm" });
    applyDelta(item, { type: "text_delta", contentIndex: 1, delta: "answer" });
    assert.deepEqual(item.partial.content, [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "answer" },
    ]);
  });

  it("replaces streamed text with the authoritative content on end", () => {
    const item = assistant();
    applyDelta(item, { type: "text_delta", contentIndex: 0, delta: "drafty" });
    applyDelta(item, { type: "text_end", contentIndex: 0, content: "final" });
    assert.deepEqual(item.partial.content, [{ type: "text", text: "final" }]);
  });

  it("ignores tool-call deltas", () => {
    const item = assistant();
    applyDelta(item, { type: "toolcall_delta", contentIndex: 0, delta: "{" });
    assert.deepEqual(item.partial.content, []);
  });
});

describe("applyEvent", () => {
  const env = (items: Item[]) => ({ tui: undefined as never, cwd: "/w", addItem: (i: Item) => items.push(i) });

  it("adds a user item and reports the finished message for the switcher", () => {
    const items: Item[] = [];
    const view = newView();
    applyEvent(view, { type: "message_start", message: { role: "user", content: "hi" } }, env(items));
    const effects = applyEvent(view, { type: "message_end", message: { role: "user", content: "hi  there" } }, env(items));
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "user");
    assert.deepEqual(effects, { messageEnded: true, summary: "hi there" });
  });

  it("adds an assistant item that was never streamed when its message ends (attached mid-run)", () => {
    const items: Item[] = [];
    const view = newView();
    applyEvent(view, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, env(items));
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "assistant");
  });

  it("leaves plain provider errors to pi's own assistant component", () => {
    const items: Item[] = [];
    const view = newView();
    applyEvent(view, { type: "message_start", message: { role: "assistant", content: [] } }, env(items));
    view.items.push(...items);
    const before = items.length;
    applyEvent(view, { type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } }, env(items));
    assert.equal(items.length, before);
  });

  it("adds an error row when the failed message has tool calls, which pi does not draw", () => {
    const items: Item[] = [];
    const view = newView();
    applyEvent(view, { type: "message_start", message: { role: "assistant", content: [] } }, env(items));
    view.items.push(...items);
    const msg = { role: "assistant", stopReason: "error", errorMessage: "boom", content: [{ type: "toolCall", id: "t", name: "bash" }] };
    applyEvent(view, { type: "message_end", message: msg }, env(items));
    assert.equal(items[items.length - 1].kind, "other");
  });

  it("ignores tool updates for tools it never saw start", () => {
    const view = newView();
    const effects = applyEvent(view, { type: "tool_execution_end", toolCallId: "nope", result: {} }, env([]));
    assert.deepEqual(effects, {});
  });
});

describe("messagesFromFile", () => {
  it("returns only message entries and tolerates a torn trailing line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-transcript-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", id: "x" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "session_info", name: "n" }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }),
        '{"type":"message","mess',
      ].join("\n"),
    );
    const messages = messagesFromFile(file) as Array<{ role: string }>;
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
    fs.rmSync(dir, { recursive: true });
  });
});
