import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isF2 } from "../src/switcher-actions.ts";

describe("isF2", () => {
  it("accepts kitty F2 with and without lock keys", () => {
    assert.ok(isF2("\x1b[Q"));
    assert.ok(isF2("\x1b[1;1Q"));
    assert.ok(isF2("\x1b[1;129Q"));
    assert.ok(isF2("\x1b[1;65Q"));
    assert.ok(isF2("\x1b[1;193:2Q"));
  });

  it("rejects F2 with a real modifier", () => {
    assert.equal(isF2("\x1b[1;2Q"), false);
    assert.equal(isF2("\x1b[1;5Q"), false);
    assert.equal(isF2("\x1b[1;133Q"), false);
  });
});
