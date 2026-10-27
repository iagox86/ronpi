import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchModel } from "../src/model-match.ts";

const models = [
  { provider: "anthropic", id: "claude-opus-5" },
  { provider: "anthropic", id: "claude-sonnet-5" },
  { provider: "litellm", id: "gemma4:12b" },
  { provider: "other", id: "claude-sonnet-5" },
];

describe("matchModel", () => {
  it("takes an exact provider/id even when the bare id exists elsewhere", () => {
    assert.deepEqual(matchModel(models, "other/claude-sonnet-5"), { kind: "one", model: models[3] });
  });

  it("takes a bare id that is unique", () => {
    assert.deepEqual(matchModel(models, "gemma4:12b"), { kind: "one", model: models[2] });
  });

  it("matches words anywhere, in any case, when only one model fits", () => {
    assert.deepEqual(matchModel(models, "OPUS"), { kind: "one", model: models[0] });
    assert.deepEqual(matchModel(models, "litellm gemma"), { kind: "one", model: models[2] });
  });

  it("reports every candidate when the words are ambiguous", () => {
    const r = matchModel(models, "claude-sonnet");
    assert.equal(r.kind, "many");
    assert.equal(r.kind === "many" && r.matches.length, 2);
  });

  it("reports nothing for an empty or unmatched query", () => {
    assert.deepEqual(matchModel(models, "  "), { kind: "none" });
    assert.deepEqual(matchModel(models, "gpt"), { kind: "none" });
  });
});
