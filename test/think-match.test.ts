import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchThinkingLevel } from "../src/think-match.ts";

const LEVELS = ["off", "minimal", "low", "medium", "high"];

describe("matchThinkingLevel", () => {
  it("matches an exact level regardless of case", () => {
    assert.deepEqual(matchThinkingLevel(LEVELS, "high"), { kind: "one", level: "high" });
    assert.deepEqual(matchThinkingLevel(LEVELS, " HIGH "), { kind: "one", level: "high" });
  });

  it("matches an unambiguous prefix", () => {
    assert.deepEqual(matchThinkingLevel(LEVELS, "hi"), { kind: "one", level: "high" });
    assert.deepEqual(matchThinkingLevel(LEVELS, "min"), { kind: "one", level: "minimal" });
    assert.deepEqual(matchThinkingLevel(LEVELS, "o"), { kind: "one", level: "off" });
  });

  it("reports every match for an ambiguous prefix", () => {
    assert.deepEqual(matchThinkingLevel(LEVELS, "m"), { kind: "many", matches: ["minimal", "medium"] });
  });

  it("reports none for a level the model does not support", () => {
    assert.deepEqual(matchThinkingLevel(LEVELS, "xhigh"), { kind: "none" });
    assert.deepEqual(matchThinkingLevel(LEVELS, "zzz"), { kind: "none" });
  });

  it("reports none for an empty query", () => {
    assert.deepEqual(matchThinkingLevel(LEVELS, ""), { kind: "none" });
    assert.deepEqual(matchThinkingLevel(LEVELS, "   "), { kind: "none" });
  });

  it("works against a single-entry list (a model without thinking)", () => {
    assert.deepEqual(matchThinkingLevel(["off"], "off"), { kind: "one", level: "off" });
    assert.deepEqual(matchThinkingLevel(["off"], "high"), { kind: "none" });
  });
});
