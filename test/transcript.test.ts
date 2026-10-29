import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { formatLocalCommand } from "../src/local-command.ts";
import { applyDelta, applyEvent, type AssistantItem, dropEcho, echoUser, type Item, itemsFromFile, itemsFromMessages, errorRow, softFailure, lengthNotice, showRawError, messagesFromFile, newView } from "../src/transcript.ts";

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

  it("shows a sent prompt at once and does not add it again when pi echoes it back", () => {
    const items: Item[] = [];
    const view = newView();
    echoUser(view, "hello", env(items));
    assert.equal(items.length, 1);
    applyEvent(view, { type: "message_start", message: { role: "user", content: "hello" } }, env(items));
    assert.equal(items.length, 1);
    assert.equal(view.echoes.length, 0);
    applyEvent(view, { type: "message_start", message: { role: "user", content: "hello" } }, env(items));
    assert.equal(items.length, 2);
  });

  it("takes an echoed prompt back out when the send failed", () => {
    const items: Item[] = [];
    const view = newView();
    echoUser(view, " oops ", env(items));
    view.items.push(...items);
    assert.equal(dropEcho(view, "oops"), true);
    assert.equal(view.items.length, 0);
    assert.equal(dropEcho(view, "oops"), false);
  });

  it("keeps the spinner of a compaction or run already going when a queued prompt is refused", () => {
    const view = newView();
    applyEvent(view, { type: "compaction_start" }, { addItem() {} } as never);
    echoUser(view, "queued?", env([]));
    dropEcho(view, "queued?");
    assert.equal(view.activity?.label, "compacting context");
  });

  it("stops the spinner a refused prompt started on an idle session", () => {
    const view = newView();
    echoUser(view, "oops", env([]));
    assert.equal(view.activity?.label, "working");
    dropEcho(view, "oops");
    assert.equal(view.activity, undefined);
  });

  it("adds an assistant item that was never streamed when its message ends (attached mid-run)", () => {
    const items: Item[] = [];
    const view = newView();
    applyEvent(view, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, env(items));
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "assistant");
  });

  it("never rewrites an older assistant item for a message whose start was missed", () => {
    const items: Item[] = [];
    const view = newView();
    const asst = (text: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: text }] });
    applyEvent(view, { type: "message_start", message: asst("") }, env(items));
    applyEvent(view, { type: "message_end", message: asst("first") }, env(items));
    view.items.push(...items);
    // the next message started while no controller listened: only updates and the end arrive
    applyEvent(view, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x" } }, env(items));
    applyEvent(view, { type: "message_end", message: asst("second") }, env(items));
    assert.equal(items.length, 2, "the second message is its own item, after the first");
    assert.equal(((items[0] as AssistantItem).partial.content[0] as { thinking: string }).thinking, "first");
    assert.equal(((items[1] as AssistantItem).partial.content[0] as { thinking: string }).thinking, "second");
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

  it("renders a failed tool's expanded block differently from a successful one", () => {
    const rendered = (isError: boolean) => {
      const items: Item[] = [];
      const view = newView();
      const tui = { requestRender() {} } as never;
      const e = { tui, cwd: "/w", addItem: (i: Item) => items.push(i) };
      applyEvent(view, { type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "x" } }, e);
      applyEvent(view, { type: "tool_execution_end", toolCallId: "t", isError, result: { content: [{ type: "text", text: "boom" }] } }, e);
      const run = items[0]?.component as { expanded: boolean; render(w: number): string[] };
      run.expanded = true;
      return run.render(60).join("\n");
    };
    assert.notEqual(rendered(true), rendered(false));
  });

  it("shows a message from another session as 'from NAME' rather than as something the user typed", () => {
    const tui = { requestRender() {} } as never;
    const label = "[from Boss (0b1c2d3e-aaaa-4bbb-8ccc-111111111111)]: please check the schema";
    const items = itemsFromMessages([{ role: "user", content: label }], tui, "/w");
    const component = items[0]?.component as unknown as { render(w: number): string[] };
    const text = component.render(80).join("\n");
    assert.match(text, /from Boss \(0b1c2d3e\)/);
    assert.match(text, /please check the schema/);
    assert.doesNotMatch(text, /\[from Boss/);
  });

  it("draws a !command result sent to the agent as a command block, live and on replay", () => {
    const tui = { requestRender() {} } as never;
    const text = formatLocalCommand("ls /x", { output: "a\nb\n", exitCode: 0, cancelled: false, truncated: false });
    const items = itemsFromMessages([{ role: "user", content: text }], tui, "/w");
    assert.equal(items[0]?.kind, "bash");
    const shown: Item[] = [];
    applyEvent(newView(), { type: "message_start", message: { role: "user", content: [{ type: "text", text }] } }, { tui, cwd: "/w", addItem: (i: Item) => shown.push(i) });
    assert.equal(shown[0]?.kind, "bash");
    const block = shown[0]?.component as unknown as { render(w: number): string[] };
    const rendered = block.render(60).join("\n");
    assert.match(rendered, /ls \/x/);
    assert.doesNotMatch(rendered, /local-command/);
  });

  it("replays a !command with its output", () => {
    const tui = { requestRender() {} } as never;
    const msg = { role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0, cancelled: false, truncated: false };
    const items = itemsFromMessages([msg], tui, "/w");
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "bash");
    const component = items[0]?.component as unknown as { render(w: number): string[] };
    const text = component.render(60).join("\n");
    assert.match(text, /echo hi/);
    assert.match(text, /hi/);
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

describe("compaction in a session file", () => {
  function file(entries: unknown[]): string {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-compact-")), "s.jsonl");
    fs.writeFileSync(f, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
    return f;
  }
  const msg = (id: string, role: string, text: string) => ({ type: "message", id, message: { role, content: text } });

  it("puts a summary marker where the compaction happened and flags what the summary replaced", () => {
    const f = file([
      { type: "session", id: "s" },
      msg("a", "user", "old question"),
      msg("b", "assistant", "old answer"),
      msg("c", "user", "recent question"),
      { type: "compaction", id: "k", summary: "they discussed X", firstKeptEntryId: "c", tokensBefore: 5000, timestamp: "2026-10-20T00:00:00Z" },
      msg("d", "assistant", "after"),
    ]);
    const ms = messagesFromFile(f) as Array<{ role: string; outOfContext?: boolean; summary?: string }>;
    assert.deepEqual(ms.map((m) => m.role), ["user", "assistant", "user", "compactionSummary", "assistant"]);
    assert.deepEqual(ms.map((m) => Boolean(m.outOfContext)), [true, true, false, false, false]);
    assert.equal(ms[3]?.summary, "they discussed X");
  });

  it("replays the marker as its own row, after the kept rows, dimming only what it replaced", () => {
    const f = file([
      msg("a", "user", "old"),
      msg("c", "user", "kept"),
      { type: "compaction", id: "k", summary: "s", firstKeptEntryId: "c", tokensBefore: 1 },
    ]);
    const items = itemsFromFile(f, {} as never, "/");
    assert.deepEqual(items.map((i) => i.kind), ["user", "user", "compaction"]);
    assert.deepEqual(items.map((i) => Boolean(i.dimmed)), [true, false, false]);
  });

  it("shows everything undimmed for a session that was never compacted", () => {
    const items = itemsFromFile(file([msg("a", "user", "hi"), msg("b", "assistant", "yo")]), {} as never, "/");
    assert.ok(items.every((i) => !i.dimmed));
  });
});

describe("lengthNotice", () => {
  it("says the output limit was hit and how much was thinking", () => {
    const text = lengthNotice({ usage: { output: 16384, reasoning: 16384 } });
    assert.match(text, /output limit/);
    assert.match(text, /16,384 output tokens, 16,384 of them thinking/);
  });

  it("still reads sensibly without usage numbers", () => {
    assert.match(lengthNotice({}), /^Stopped: hit the model's output limit before finishing/);
  });
});

describe("error rows", () => {
  const raw = '502: {"message":"upstream failed","type":"bad_gateway"}';
  const text = (item: ReturnType<typeof errorRow>) => item.component.render(120).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

  it("show the tidy error until asked for the original", () => {
    const item = errorRow(raw);
    assert.match(text(item), /Error: 502 bad_gateway: upstream failed/);
    showRawError(item, true);
    assert.match(text(item), /\{"message":"upstream failed"/);
    showRawError(item, false);
    assert.doesNotMatch(text(item), /\{/);
  });
});

describe("softFailure", () => {
  const text = (s: string) => [{ type: "text", text: s }];

  it("recognizes a tool that reports success:false in its JSON text", () => {
    assert.equal(softFailure(text('{"success":false,"error":"no match"}')), true);
  });

  it("leaves ordinary output alone, including JSON that merely mentions success", () => {
    assert.equal(softFailure(text('{"success":true}')), false);
    assert.equal(softFailure(text("success: false")), false);
    assert.equal(softFailure(text('{"items":[],"success":"false"}')), false);
    assert.equal(softFailure(text("not json {")), false);
    assert.equal(softFailure(undefined), false);
  });
});
