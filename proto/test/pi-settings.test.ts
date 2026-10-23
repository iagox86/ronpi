import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wheelScrollLines } from "../pi-settings.ts";

describe("wheelScrollLines", () => {
  it("defaults to pi's accelerating auto mode", () => {
    assert.equal(wheelScrollLines({}), "auto");
    assert.equal(wheelScrollLines({ fullscreenWheelScrollLines: "auto" }), "auto");
  });

  it("honors a fixed line count from pi's settings", () => {
    assert.equal(wheelScrollLines({ fullscreenWheelScrollLines: 3 }), 3);
  });

  it("ignores out-of-range or malformed values", () => {
    assert.equal(wheelScrollLines({ fullscreenWheelScrollLines: 0 }), "auto");
    assert.equal(wheelScrollLines({ fullscreenWheelScrollLines: 500 }), "auto");
    assert.equal(wheelScrollLines({ fullscreenWheelScrollLines: "fast" }), "auto");
  });
});
