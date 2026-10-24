import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, learn, learnFromHistory, type Table, threshold, warningFor } from "../../pi/extensions/ronpi-cache-warn.ts";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const hit = { input: 500, cacheRead: 100_000 };
const miss = { input: 100_000, cacheRead: 0 };

describe("cache hit/miss classification", () => {
  it("calls mostly-cached prompts hits and uncached ones misses", () => {
    assert.equal(classify(hit), "hit");
    assert.equal(classify(miss), "miss");
  });

  it("ignores small prompts and mixed ones", () => {
    assert.equal(classify({ input: 800, cacheRead: 0 }), undefined);
    assert.equal(classify({ input: 70_000, cacheRead: 30_000 }), undefined);
  });
});

describe("learning the expiry", () => {
  it("brackets the expiry between the longest hit and the shortest miss", () => {
    const t: Table = {};
    learn(t, "p/m", 2 * MIN, hit);
    learn(t, "p/m", 4 * MIN, hit);
    learn(t, "p/m", 9 * MIN, miss);
    learn(t, "p/m", 30 * MIN, miss);
    assert.deepEqual(t["p/m"], { maxHit: 4 * MIN, minMiss: 9 * MIN });
    assert.equal(threshold(t["p/m"]), 9 * MIN);
  });

  it("does not take a quick miss as expiry, since the prefix must have changed", () => {
    const t: Table = {};
    learn(t, "p/m", 10_000, miss);
    assert.equal(threshold(t["p/m"]), undefined);
  });

  it("trusts hits over a shorter recorded miss", () => {
    assert.equal(threshold({ maxHit: 20 * MIN, minMiss: 5 * MIN }), 20 * MIN + 1);
  });

  it("learns from a replayed session history", () => {
    const msg = (timestamp: number, usage: object) => ({
      type: "message",
      message: { role: "assistant", provider: "p", model: "m", timestamp, usage },
    });
    const t: Table = {};
    const changed = learnFromHistory(t, [msg(T0, hit), msg(T0 + 3 * MIN, hit), msg(T0 + 20 * MIN, miss)]);
    assert.equal(changed, true);
    assert.deepEqual(t["p/m"], { maxHit: 3 * MIN, minMiss: 17 * MIN });
  });
});

describe("warning before sending", () => {
  const last = { role: "assistant", timestamp: T0, usage: { input: 500, cacheRead: 199_500 } };
  const learned = { maxHit: 4 * MIN, minMiss: 9 * MIN };

  it("stays quiet while the expiry is unknown", () => {
    assert.equal(warningFor(last, undefined, undefined, T0 + 60 * MIN), undefined);
  });

  it("stays quiet inside the learned window or for a small context", () => {
    assert.equal(warningFor(last, learned, undefined, T0 + 5 * MIN), undefined);
    const small = { ...last, usage: { input: 100, cacheRead: 9_000 } };
    assert.equal(warningFor(small, learned, undefined, T0 + 60 * MIN), undefined);
  });

  it("warns with the token count and the price difference", () => {
    const text = warningFor(last, learned, { input: 0.5, cacheRead: 0.1 }, T0 + 12 * MIN);
    assert.match(text ?? "", /200K tokens/);
    assert.match(text ?? "", /\$0\.08/);
  });
});
