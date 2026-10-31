import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MOUSE_OFF, MOUSE_ON, mouseNotice, nextMouse, parseMouseArg } from "../src/mouse.ts";
import { buildStatusLine } from "../src/status.ts";

describe("mouse escape codes", () => {
  it("turn button-motion reporting, focus reports and SGR coordinates on, exactly as pi-tui does at start", () => {
    assert.equal(MOUSE_ON, "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h");
  });

  it("switch every reporting mode off, including all-motion", () => {
    for (const mode of ["1000", "1002", "1003", "1004", "1006"]) {
      assert.ok(MOUSE_OFF.includes(`\x1b[?${mode}l`), mode);
    }
    assert.ok(!MOUSE_OFF.includes("h"), "nothing is switched on");
  });
});

describe("parseMouseArg / nextMouse", () => {
  it("reads on, off, toggle (any case), and no argument as a plain state report", () => {
    assert.equal(parseMouseArg(""), "status");
    assert.equal(parseMouseArg("Toggle"), "toggle");
    assert.equal(parseMouseArg(" OFF "), "off");
    assert.equal(parseMouseArg("on"), "on");
    assert.equal(parseMouseArg("toggle"), "toggle");
    assert.equal(parseMouseArg("maybe"), undefined);
  });

  it("computes the state after each choice", () => {
    assert.equal(nextMouse(true, "off"), false);
    assert.equal(nextMouse(false, "on"), true);
    assert.equal(nextMouse(true, "toggle"), false);
    assert.equal(nextMouse(false, "toggle"), true);
    assert.equal(nextMouse(false, "status"), false);
    assert.equal(nextMouse(true, "status"), true);
  });
});

describe("mouseNotice", () => {
  it("says what changed, and how to get back", () => {
    assert.match(mouseNotice(false, true), /mouse off.*terminal handles select/);
    assert.match(mouseNotice(false, false), /mouse is off.*\/mouse on/);
    assert.match(mouseNotice(true, true), /mouse on/);
  });
});

describe("status line", () => {
  const base = { switcherOpen: false, viewing: "/s.jsonl", stats: { running: 0, waiting: 0, tokens: 0, cost: 0 }, flash: "" };

  it("shows a mouse off marker only while the mouse is off", () => {
    assert.match(buildStatusLine({ ...base, mouseOff: true }), /mouse off/);
    assert.doesNotMatch(buildStatusLine({ ...base }), /mouse off/);
  });
});
