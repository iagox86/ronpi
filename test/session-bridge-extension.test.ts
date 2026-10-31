import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.TORIEL_CHILD = "1";
const ext = await import("../pi/extensions/toriel-session-bridge.ts");

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

/** A pi stand-in that records what the extension registers and sends. */
function fakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const sent: Array<{ message: Record<string, unknown>; options?: { triggerTurn?: boolean } }> = [];
  const statuses: Array<Record<string, unknown>> = [];
  const branch: Array<Record<string, unknown>> = [];
  let sendFails = false;
  const ctx = {
    sessionManager: { getBranch: () => branch },
    ui: { setStatus: (key: string, text: string | undefined) => key === "toriel-bridge" && statuses.push(JSON.parse(text as string)) },
  };
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    registerCommand: (name: string, o: { handler: (a: string, c: unknown) => Promise<void> }) => commands.set(name, o.handler),
    sendMessage: async (message: Record<string, unknown>, options?: { triggerTurn?: boolean }) => {
      if (sendFails) {
        throw new Error("no model");
      }
      sent.push({ message, options });
      branch.push({ type: "custom_message", customType: "toriel-inject", details: message.details });
    },
  };
  ext.default(pi as never);
  return {
    ctx,
    sent,
    statuses,
    branch,
    failSends: () => {
      sendFails = true;
    },
    inject: (id: string, text: string) => commands.get("toriel-inject")?.(JSON.stringify({ id, text }), ctx),
    fire: (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.(event, ctx),
    hasCommand: () => commands.has("toriel-inject"),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("session bridge extension", () => {
  it("registers the inject command", () => {
    assert.equal(fakePi().hasCommand(), true);
  });

  it("starts a turn with the message when the session is idle, and confirms it from the transcript", async () => {
    const pi = fakePi();
    await pi.inject("b1", "hello");
    await tick();
    assert.equal(pi.sent.length, 1);
    assert.deepEqual(pi.sent[0]?.options, { triggerTurn: true });
    assert.deepEqual(pi.sent[0]?.message.details, { id: "b1" });
    pi.fire("agent_settled");
    assert.deepEqual(pi.statuses, [{ v: 1, kind: "injected", id: "b1" }]);
  });

  it("holds messages while a run is in flight and hands them over together at the turn boundary", async () => {
    const pi = fakePi();
    pi.fire("agent_start");
    await pi.inject("b1", "first");
    await pi.inject("b2", "second");
    await tick();
    assert.equal(pi.sent.length, 0, "nothing is sent mid-run");
    const result = pi.fire("turn_end", { outcome: "completed" }) as { entries: Array<{ details: { id: string }; content: string }>; continue: boolean };
    assert.deepEqual(result.entries.map((e) => [e.details.id, e.content]), [["b1", "first"], ["b2", "second"]]);
    assert.equal(result.continue, true);
    assert.equal(pi.fire("turn_end", { outcome: "completed" }), undefined, "each message is handed over once");
  });

  it("delivers at the end of the run too, so a message that arrives during the last turn is not stranded", async () => {
    const pi = fakePi();
    pi.fire("agent_start");
    await pi.inject("b1", "late");
    const result = pi.fire("agent_before_settle", { outcome: "completed" }) as { entries: unknown[] };
    assert.equal(result.entries.length, 1);
  });

  it("hands nothing over from an aborted turn", async () => {
    const pi = fakePi();
    pi.fire("agent_start");
    await pi.inject("b1", "x");
    assert.equal(pi.fire("turn_end", { outcome: "aborted" }), undefined);
  });

  it("confirms boundary messages once they show in the transcript, and puts back ones that never did", async () => {
    const pi = fakePi();
    pi.fire("agent_start");
    await pi.inject("b1", "landed");
    await pi.inject("b2", "lost to an abort");
    pi.fire("turn_end", { outcome: "completed" });
    pi.branch.push({ type: "custom_message", customType: "toriel-inject", details: { id: "b1" } });
    pi.fire("turn_start");
    assert.deepEqual(pi.statuses, [{ v: 1, kind: "injected", id: "b1" }]);
    pi.fire("agent_settled");
    assert.deepEqual(pi.statuses.at(-1), { v: 1, kind: "requeued", ids: ["b2"] });
    await tick();
    assert.deepEqual(pi.sent.map((s) => s.message.details), [{ id: "b2" }], "the lost one is sent again once idle");
  });

  it("does not requeue mid-run, when the append may just be late", async () => {
    const pi = fakePi();
    pi.fire("agent_start");
    await pi.inject("b1", "x");
    pi.fire("turn_end", { outcome: "completed" });
    pi.fire("turn_start");
    assert.deepEqual(pi.statuses, []);
    await tick();
    assert.equal(pi.sent.length, 0);
  });

  it("reports a failed send instead of dropping it silently", async () => {
    const pi = fakePi();
    pi.failSends();
    await pi.inject("b1", "x");
    await tick();
    assert.deepEqual(pi.statuses, [{ v: 1, kind: "failed", id: "b1", error: "no model" }]);
  });

  it("reports a malformed request", async () => {
    const pi = fakePi();
    await pi.inject("", "x");
    assert.equal(pi.statuses.at(-1)?.kind, "failed");
    assert.equal(pi.sent.length, 0);
  });
});

describe("inject requests", () => {
  it("parses a well-formed request and rejects the rest", () => {
    assert.deepEqual(ext.parseInject('{"id":"b1","text":"hi"}'), { id: "b1", text: "hi" });
    assert.equal(ext.parseInject("nope"), undefined);
    assert.equal(ext.parseInject('{"id":"","text":"x"}'), undefined);
    assert.equal(ext.parseInject('{"id":"b1"}'), undefined);
  });
});
