import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BridgeTracker, injectedId, mergedQueueTexts, parseBridgeReport } from "../src/daemon-bridge.ts";

describe("bridge tracker", () => {
  it("gives every inject its own id", () => {
    const t = new BridgeTracker();
    const ids = [t.newId(), t.newId(), t.newId()];
    assert.equal(new Set(ids).size, 3);
  });

  it("keeps injects in order until each is confirmed, and confirming one leaves the others", () => {
    const t = new BridgeTracker();
    const [a, b] = [t.newId(), t.newId()];
    t.track(7, { id: a, text: "first" });
    t.track(7, { id: b, text: "second" });
    assert.deepEqual(t.texts(7), ["first", "second"]);
    t.ack(7, a);
    assert.deepEqual(t.texts(7), ["second"]);
    t.ack(7, b);
    assert.deepEqual(t.texts(7), []);
    t.ack(7, "nope"); // an unknown or repeated ack is harmless
  });

  it("keeps sessions apart", () => {
    const t = new BridgeTracker();
    t.track(1, { id: t.newId(), text: "for one" });
    t.track(2, { id: t.newId(), text: "for two" });
    assert.deepEqual(t.texts(1), ["for one"]);
    assert.deepEqual(t.texts(2), ["for two"]);
  });

  it("hands a failed inject back, once", () => {
    const t = new BridgeTracker();
    const id = t.newId();
    t.track(1, { id, text: "hello" });
    assert.deepEqual(t.fail(1, id), { id, text: "hello" });
    assert.equal(t.fail(1, id), undefined);
    assert.deepEqual(t.texts(1), []);
  });

  it("reports what a vanished child never confirmed", () => {
    const t = new BridgeTracker();
    const [a, b] = [t.newId(), t.newId()];
    t.track(3, { id: a, text: "one" });
    t.track(3, { id: b, text: "two" });
    t.ack(3, a);
    assert.deepEqual(t.clear(3), [{ id: b, text: "two" }]);
    assert.deepEqual(t.texts(3), []);
    assert.deepEqual(t.clear(3), []);
  });

  it("warns about a missing bridge once per session, and again after the child restarts", () => {
    const t = new BridgeTracker();
    assert.equal(t.shouldWarnLegacy(1), true);
    assert.equal(t.shouldWarnLegacy(1), false);
    t.clear(1);
    assert.equal(t.shouldWarnLegacy(1), true);
  });
});

describe("what the strip shows", () => {
  it("lists compaction-held messages before bridge-pending ones", () => {
    assert.deepEqual(mergedQueueTexts(["held"], ["pending"]), ["held", "pending"]);
  });
});

describe("pi events that show an inject landing", () => {
  const custom = { customType: "toriel-inject", details: { id: "b4" } };

  it("reads the id from an appended entry (boundary delivery) and a finished message (idle delivery)", () => {
    assert.equal(injectedId({ type: "entry_appended", entry: { type: "custom_message", ...custom } }), "b4");
    assert.equal(injectedId({ type: "message_end", message: { role: "custom", ...custom } }), "b4");
  });

  it("ignores everything else", () => {
    assert.equal(injectedId({ type: "message_start", message: { role: "custom", ...custom } }), undefined);
    assert.equal(injectedId({ type: "entry_appended", entry: { type: "custom_message", customType: "other", details: { id: "b4" } } }), undefined);
    assert.equal(injectedId({ type: "message_end", message: { role: "user" } }), undefined);
    assert.equal(injectedId({ type: "entry_appended", entry: { customType: "toriel-inject" } }), undefined);
  });
});

describe("bridge status records", () => {
  const record = (r: unknown) => ({ method: "setStatus", statusKey: "toriel-bridge", statusText: JSON.stringify(r) });

  it("parses injected, failed and requeued reports", () => {
    assert.deepEqual(parseBridgeReport(record({ v: 1, kind: "injected", id: "b1" })), { kind: "injected", id: "b1" });
    assert.deepEqual(parseBridgeReport(record({ v: 1, kind: "failed", id: "b2", error: "boom" })), { kind: "failed", id: "b2", error: "boom" });
    assert.deepEqual(parseBridgeReport(record({ v: 1, kind: "requeued", ids: ["b3"] })), { kind: "requeued", ids: ["b3"] });
  });

  it("leaves other records and malformed ones alone", () => {
    assert.equal(parseBridgeReport({ method: "setStatus", statusKey: "toriel-usage", statusText: "{}" }), undefined);
    assert.equal(parseBridgeReport({ method: "notify", statusKey: "toriel-bridge" }), undefined);
    assert.equal(parseBridgeReport({ method: "setStatus", statusKey: "toriel-bridge", statusText: "not json" }), undefined);
    assert.equal(parseBridgeReport(record({ v: 2, kind: "injected", id: "b1" })), undefined);
    assert.equal(parseBridgeReport(record({ v: 1, kind: "injected" })), undefined);
  });
});
