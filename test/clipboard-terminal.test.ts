import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClipboardTerminal, middleButton } from "../src/clipboard-terminal.ts";

describe("middleButton", () => {
  it("recognizes a middle press and its release", () => {
    assert.equal(middleButton("\x1b[<1;40;12M"), "press");
    assert.equal(middleButton("\x1b[<1;40;12m"), "release");
  });

  it("leaves the left and right buttons, motion and the wheel to the TUI", () => {
    assert.equal(middleButton("\x1b[<0;40;12M"), undefined);
    assert.equal(middleButton("\x1b[<2;40;12M"), undefined);
    assert.equal(middleButton("\x1b[<33;40;12M"), undefined); // middle-button drag
    assert.equal(middleButton("\x1b[<65;40;12M"), undefined); // wheel
  });

  it("ignores keys and other escape sequences", () => {
    assert.equal(middleButton("a"), undefined);
    assert.equal(middleButton("\x1b[1;129C"), undefined);
  });
});

describe("ClipboardTerminal", () => {
  /** Feed input through the terminal's wrapper without a real TTY. */
  function feed(handled: boolean, inputs: string[]) {
    const seen: string[] = [];
    let pastes = 0;
    const term = new ClipboardTerminal(() => {
      pastes++;
      return handled;
    });
    // the base class needs a TTY to start; capture the wrapper it would be given
    (Object.getPrototypeOf(ClipboardTerminal.prototype) as { start: unknown }).start = (onInput: (d: string) => void) => {
      for (const data of inputs) {
        onInput(data);
      }
    };
    term.start((d) => seen.push(d), () => {});
    return { seen, pastes };
  }

  it("keeps a handled middle click, and its release, away from the TUI", () => {
    const r = feed(true, ["a", "\x1b[<1;5;5M", "\x1b[<1;5;5m", "b"]);
    assert.deepEqual(r.seen, ["a", "b"]);
    assert.equal(r.pastes, 1);
  });

  it("passes the click on untouched when it cannot paste", () => {
    const r = feed(false, ["\x1b[<1;5;5M", "\x1b[<1;5;5m"]);
    assert.deepEqual(r.seen, ["\x1b[<1;5;5M", "\x1b[<1;5;5m"]);
  });
});
