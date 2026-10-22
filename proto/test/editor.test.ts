import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPlainLeft } from "../editor.ts";

describe("isPlainLeft", () => {
  it("accepts the legacy left-arrow encodings", () => {
    assert.equal(isPlainLeft("\x1b[D"), true);
    assert.equal(isPlainLeft("\x1bOD"), true);
  });

  it("accepts kitty/csi-u left with only lock bits set", () => {
    assert.equal(isPlainLeft("\x1b[1;1D"), true);
    assert.equal(isPlainLeft("\x1b[1;65D"), true); // caps lock
    assert.equal(isPlainLeft("\x1b[1;129D"), true); // num lock
  });

  it("rejects left with a real modifier", () => {
    assert.equal(isPlainLeft("\x1b[1;2D"), false); // shift
    assert.equal(isPlainLeft("\x1b[1;5D"), false); // ctrl
  });

  it("rejects key-release events and other keys", () => {
    assert.equal(isPlainLeft("\x1b[1;1:3D"), false);
    assert.equal(isPlainLeft("\x1b[C"), false);
    assert.equal(isPlainLeft("a"), false);
  });
});
