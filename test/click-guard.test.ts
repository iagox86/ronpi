import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clickMode, passesToTranscript } from "../src/click-guard.ts";

describe("click guard", () => {
  it("drops a single click on the transcript", () => {
    assert.equal(passesToTranscript({ type: "click", clickCount: 1 }, "double"), false);
    assert.equal(passesToTranscript({ type: "click" }, "double"), false);
  });

  it("passes a double click", () => {
    assert.equal(passesToTranscript({ type: "click", clickCount: 2 }, "double"), true);
  });

  it("leaves presses, drags and wheel events alone", () => {
    for (const type of ["press", "release", "drag", "move", "wheel"]) {
      assert.equal(passesToTranscript({ type }, "double"), true);
    }
  });

  it("passes single clicks when TORIEL_CLICK=single", () => {
    assert.equal(clickMode({ TORIEL_CLICK: "single" }), "single");
    assert.equal(clickMode({}), "double");
    assert.equal(passesToTranscript({ type: "click", clickCount: 1 }, "single"), true);
  });
});
