import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fmtAge, fmtTokens, lastLine, messageText, oneLineFlat } from "../src/format.ts";

describe("fmtAge", () => {
  it("uses the largest whole unit", () => {
    assert.equal(fmtAge(30_000), "30s");
    assert.equal(fmtAge(5 * 60_000), "5m");
    assert.equal(fmtAge(3 * 3_600_000), "3h");
    assert.equal(fmtAge(50 * 3_600_000), "2d");
  });

  it("never goes negative", () => {
    assert.equal(fmtAge(-5000), "0s");
  });
});

describe("fmtTokens", () => {
  it("abbreviates thousands and millions", () => {
    assert.equal(fmtTokens(999), "999");
    assert.equal(fmtTokens(1500), "1.5k");
    assert.equal(fmtTokens(2_500_000), "2.5M");
  });
});

describe("oneLineFlat", () => {
  it("collapses whitespace and newlines", () => {
    assert.equal(oneLineFlat("a\n\n  b\tc", 50), "a b c");
  });

  it("truncates with an ellipsis within the width", () => {
    const out = oneLineFlat("abcdefghij", 6);
    assert.equal(out, "abcde...");
  });
});

describe("lastLine", () => {
  it("keeps the tail of long text", () => {
    assert.equal(lastLine("x".repeat(200), 10), `...${"x".repeat(10)}`);
  });

  it("returns short text unchanged", () => {
    assert.equal(lastLine("short  text"), "short text");
  });
});

describe("messageText", () => {
  it("returns string content as is", () => {
    assert.equal(messageText({ content: "hello" }), "hello");
  });

  it("joins only the text blocks of block content", () => {
    const content = [
      { type: "text", text: "one" },
      { type: "toolCall", name: "bash" },
      { type: "text", text: "two" },
    ];
    assert.equal(messageText({ content }), "one\ntwo");
  });

  it("is empty for anything else", () => {
    assert.equal(messageText({ content: 42 }), "");
  });
});
