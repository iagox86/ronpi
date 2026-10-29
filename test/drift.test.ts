import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { drifted, messagesAdded } from "../src/drift.ts";

describe("messagesAdded", () => {
  it("counts finished user, assistant, tool-result and custom messages once", () => {
    for (const role of ["user", "assistant", "toolResult", "custom"]) {
      assert.equal(messagesAdded({ type: "message_end", message: { role } }), 1, role);
    }
    assert.equal(messagesAdded({ type: "message_start", message: { role: "user" } }), 0);
  });

  it("counts a boundary-appended custom message, which has no message events", () => {
    assert.equal(messagesAdded({ type: "entry_appended", entry: { type: "custom_message" } }), 1);
    assert.equal(messagesAdded({ type: "entry_appended", entry: { type: "label" } }), 0);
  });
});

describe("drifted", () => {
  it("is false when the counts agree, and while a run is streaming", () => {
    assert.equal(drifted(5, { messages: 5, streaming: false }), false);
    assert.equal(drifted(3, { messages: 5, streaming: true }), false);
  });

  it("is true when a settled session holds a different number of messages", () => {
    assert.equal(drifted(4, { messages: 5, streaming: false }), true);
    assert.equal(drifted(6, { messages: 5, streaming: false }), true);
  });

  it("does not judge a view that never had a history", () => {
    assert.equal(drifted(undefined, { messages: 5, streaming: false }), false);
  });
});
