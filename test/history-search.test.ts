import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HistorySearch } from "../src/history-search.ts";

const type = (s: HistorySearch, text: string) => {
  for (const ch of text) {
    s.handleKey(ch);
  }
};
const history = ["build it", "run tests", "/rename foo", "run lint", "deploy"];

describe("history search", () => {
  it("starts on the newest entry and narrows as you type", () => {
    const s = new HistorySearch();
    s.open(history);
    assert.equal(s.current(), "deploy");
    type(s, "run");
    assert.equal(s.current(), "run lint");
  });

  it("steps to older matches with ctrl-r and back with ctrl-s", () => {
    const s = new HistorySearch();
    s.open(history);
    type(s, "run");
    s.handleKey("\x12");
    assert.equal(s.current(), "run tests");
    s.handleKey("\x12");
    assert.equal(s.current(), "run tests", "stays on the oldest match");
    s.handleKey("\x13");
    assert.equal(s.current(), "run lint");
  });

  it("matches case-insensitively and finds slash commands", () => {
    const s = new HistorySearch();
    s.open(history);
    type(s, "RENAME");
    assert.equal(s.current(), "/rename foo");
  });

  it("widens the match again on backspace", () => {
    const s = new HistorySearch();
    s.open(history);
    type(s, "buildx");
    assert.equal(s.current(), undefined);
    s.handleKey("\x7f");
    assert.equal(s.current(), "build it");
  });

  it("accepts on enter, cancels on esc, and cancels enter when nothing matches", () => {
    const s = new HistorySearch();
    s.open(history);
    assert.equal(s.handleKey("\r"), "accept");
    assert.equal(s.handleKey("\x1b"), "cancel");
    type(s, "zzz");
    assert.equal(s.handleKey("\r"), "cancel");
  });

  it("lists a repeated message once, at its newest position", () => {
    const s = new HistorySearch();
    s.open(["a", "b", "a"]);
    type(s, "");
    assert.equal(s.current(), "a");
    s.handleKey("\x12");
    assert.equal(s.current(), "b");
    s.handleKey("\x12");
    assert.equal(s.current(), "b");
  });

  it("shows the query and the current match as the prompt text", () => {
    const s = new HistorySearch();
    s.open(history);
    type(s, "run");
    assert.equal(s.promptText(), "(reverse-search) run: run lint");
    type(s, "x");
    assert.equal(s.promptText(), "(failed reverse-search) runx: ");
  });
});
