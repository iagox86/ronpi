import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { autoSummaryFailure, cleanSummary, describeFailure, EmptyReplyError, needsResummary, QUIET_MS, runSummarizer, transcriptOf } from "../src/summarize.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "toriel-summarize-"));

function sessionFile(messages: Array<[string, string]>): string {
  const file = path.join(tmp(), "s.jsonl");
  const lines = [
    { type: "session", id: "sid" },
    { type: "model_change", id: "m", modelId: "x" },
    ...messages.map(([role, text], i) => ({
      type: "message",
      id: `e${i}`,
      message: { role, content: role === "user" ? text : [{ type: "text", text }] },
    })),
    { type: "message", id: "t", message: { role: "toolResult", content: "tool output" } },
  ];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return file;
}

/** A stand-in for pi's cli.js: prints `reply` after reading stdin, or fails. */
function fakeCli(body: string): string {
  const file = path.join(tmp(), "cli.mjs");
  fs.writeFileSync(file, body);
  return file;
}

describe("transcriptOf", () => {
  it("keeps only user and assistant text, labelled, and counts them", () => {
    const file = sessionFile([
      ["user", "fix the login bug"],
      ["assistant", "looking at auth.ts"],
    ]);
    const { text, messages } = transcriptOf(file);
    assert.equal(messages, 2);
    assert.equal(text, "User: fix the login bug\nAssistant: looking at auth.ts");
  });

  it("sends little text by default: short clips and a small total", () => {
    const file = sessionFile(Array.from({ length: 40 }, (_, i) => ["user", `n${i} ${"y".repeat(500)}`]));
    const { text } = transcriptOf(file);
    assert.ok(text.length < 2700, `transcript was ${text.length} chars`);
    assert.ok(!text.includes("y".repeat(300)), "each message is clipped");
  });

  it("keeps the start and the most recent part of a long conversation", () => {
    const file = sessionFile(Array.from({ length: 60 }, (_, i) => ["user", `message number ${i} ${"x".repeat(100)}`]));
    const { text } = transcriptOf(file, 1000);
    assert.ok(text.length < 1100);
    assert.match(text, /message number 0 /);
    assert.match(text, /\[\.\.\.\]/);
    assert.match(text, /message number 59 /);
  });
});

describe("cleanSummary", () => {
  it("takes the first non-empty line and strips quotes", () => {
    assert.equal(cleanSummary('\n  "Debugging the login flow"\nextra chatter'), "Debugging the login flow");
  });

  it("caps an overlong line", () => {
    const out = cleanSummary("a".repeat(300));
    assert.equal(out.length, 100);
    assert.ok(out.endsWith("..."));
  });
});

describe("runSummarizer", () => {
  it("returns the model's one-line reply, having been fed the transcript on stdin", async () => {
    const piCli = fakeCli(
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("\\"saw "+s.length+" chars\\"\\nignored"));',
    );
    assert.equal(await runSummarizer({ piCli, model: "m", transcript: "hello" }), "saw 5 chars");
  });

  it("explains a failure with pi's own error text", async () => {
    const piCli = fakeCli('console.error("model not found: nope");process.exit(1);');
    await assert.rejects(runSummarizer({ piCli, model: "nope", transcript: "x" }), /model not found: nope/);
  });

  it("says so when the model returns nothing, instead of reporting a bare exit code", async () => {
    const piCli = fakeCli("process.stdin.resume();process.stdin.on('end',()=>process.exit(0));");
    await assert.rejects(runSummarizer({ piCli, model: "m", transcript: "x" }), (e: Error) => {
      assert.ok(e instanceof EmptyReplyError);
      assert.match(e.message, /returned no text.*--chars/);
      return true;
    });
  });

  it("gives up on a model that never answers", async () => {
    const piCli = fakeCli("setInterval(()=>{},1000);");
    await assert.rejects(runSummarizer({ piCli, model: "slow", transcript: "x", timeoutMs: 200 }), /timed out/);
  });
});

describe("needsResummary", () => {
  const now = 10_000_000;
  const entry = { text: "t", messages: 10, at: "x", model: "m" };
  const base = { entry, messages: 20, modifiedMs: now - QUIET_MS - 1, now, streaming: false };

  it("redoes a summary once enough messages have been added and the session is quiet", () => {
    assert.equal(needsResummary(base), true);
  });

  it("leaves a session with few new messages alone", () => {
    assert.equal(needsResummary({ ...base, messages: 12 }), false);
    assert.equal(needsResummary({ ...base, messages: 12, minNew: 2 }), true);
  });

  it("waits while the session is running or was just written to", () => {
    assert.equal(needsResummary({ ...base, streaming: true }), false);
    assert.equal(needsResummary({ ...base, modifiedMs: now - 1000 }), false);
  });

  it("writes a first summary once a session has enough messages", () => {
    assert.equal(needsResummary({ ...base, entry: undefined, messages: 8 }), true);
    assert.equal(needsResummary({ ...base, entry: undefined, messages: 3 }), false);
  });
});

describe("describeFailure", () => {
  it("unwraps a gateway error instead of showing its JSON", () => {
    const text = describeFailure("litellm/gemma4:12b", '500: {"message":"litellm.InternalServerError: ollama connection failed","type":"None","code":"500"}', 1);
    assert.match(text, /^summarizer \(litellm\/gemma4:12b\) failed: 500 None: litellm\.InternalServerError/);
    assert.doesNotMatch(text, /[{}]/);
  });

  it("says the server is unreachable when it cannot be connected to", () => {
    assert.match(describeFailure("m", "Connection error.", 1), /Connection error\. - the model's server is unreachable/);
  });

  it("points at the settings when the model is unknown, ignoring pi's warnings", () => {
    const stderr = 'Warning: something harmless\nError: Model "ollama/gemma4:12b" not found. Use --list-models to see available models.';
    const text = describeFailure("ollama/gemma4:12b", stderr, 1);
    assert.doesNotMatch(text, /harmless/);
    assert.match(text, /not found.*summaryModel/);
  });

  it("shows the text of a proxy's HTML error page without its markup", () => {
    assert.match(describeFailure("m", "502 <html><body><h1>502 Bad Gateway</h1></body></html>", 1), /failed: 502 502 Bad Gateway$/);
  });

  it("falls back to the exit code when pi printed nothing", () => {
    assert.match(describeFailure("m", "", 3), /failed: exit 3$/);
  });
});

describe("autoSummaryFailure", () => {
  it("announces a new failure once and stays quiet while the reason is unchanged", () => {
    const first = autoSummaryFailure(null, new Error("Connection error."));
    assert.match(first.notify ?? "", /auto-summary is failing: Connection error\./);
    assert.equal(autoSummaryFailure(first.seen, new Error("Connection error.")).notify, undefined);
  });

  it("announces again when the reason changes", () => {
    const next = autoSummaryFailure("Connection error.", new Error("403 budget_exceeded"));
    assert.match(next.notify ?? "", /budget_exceeded/);
  });
});
