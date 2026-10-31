import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { osc52, osc52Output, osc52Result, tmuxPassthrough } from "../src/osc52.ts";

describe("osc52", () => {
  it("encodes the text as base64 in a set-clipboard sequence", () => {
    assert.equal(osc52("hi"), "\x1b]52;c;aGk=\x07");
  });

  it("sets the primary selection with its own sequence", () => {
    assert.equal(osc52("hi", "p"), "\x1b]52;p;aGk=\x07");
  });

  it("wraps for tmux passthrough with every inner ESC doubled", () => {
    assert.equal(tmuxPassthrough("\x1b]52;c;aGk=\x07"), "\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\");
  });

  it("sends the plain sequence outside tmux, and both inside it", () => {
    const both = osc52("hi") + osc52("hi", "p");
    assert.equal(osc52Output("hi", {}), both);
    assert.equal(osc52Output("hi", { TMUX: "/tmp/tmux-1/default,1,0" }), both + tmuxPassthrough(both));
  });

  it("does not claim the copy worked, and names the tmux settings only under tmux", () => {
    assert.match(osc52Result({}), /not confirmed/);
    assert.doesNotMatch(osc52Result({}), /tmux/);
    assert.match(osc52Result({ TMUX: "x" }), /set-clipboard on or allow-passthrough on/);
  });
});
