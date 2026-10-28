import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayText, formatReceived, parseReceived } from "../src/received.ts";

const ID = "0b1c2d3e-aaaa-4bbb-8ccc-111111111111";

describe("received messages", () => {
  it("round-trips the sender and body, multi-line bodies included", () => {
    const text = formatReceived("Mealie", ID, "line one\nline two");
    assert.deepEqual(parseReceived(text), { fromName: "Mealie", fromId: ID, text: "line one\nline two" });
  });

  it("keeps a sender name with parentheses or colons readable", () => {
    const r = parseReceived(formatReceived("Plan (v2): draft", ID, "hi"));
    assert.equal(r?.fromName, "Plan (v2): draft");
    assert.equal(r?.text, "hi");
  });

  it("flattens newlines in the sender name so the label stays on one line", () => {
    assert.equal(parseReceived(formatReceived("a\nb", ID, "x"))?.fromName, "a b");
  });

  it("does not mistake ordinary text for a message", () => {
    assert.equal(parseReceived("[from nobody]: hi"), undefined);
    assert.equal(parseReceived("hello [from X (id)]: hi"), undefined);
  });

  it("shows a received message as 'from NAME' over its body and leaves other text alone", () => {
    assert.equal(displayText(formatReceived("Boss", ID, "do it")), "◂ from Boss (0b1c2d3e)\ndo it");
    assert.equal(displayText("plain"), "plain");
  });
});
