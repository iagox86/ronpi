import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InfoPanel } from "../src/info-panel.ts";

describe("info panel actions", () => {
  it("runs the action for its key, closes, and ignores other keys", () => {
    const panel = new InfoPanel();
    const ran: string[] = [];
    panel.show("answer", [{ key: "c", label: "copies", run: () => ran.push("c") }]);
    assert.equal(panel.act("x"), false);
    assert.ok(panel.isOpen);
    assert.equal(panel.act("c"), true);
    assert.deepEqual(ran, ["c"]);
    assert.equal(panel.isOpen, false);
  });

  it("lists the keys in the footer", () => {
    const panel = new InfoPanel();
    panel.show("answer", [{ key: "s", label: "saves", run: () => {} }]);
    assert.match(panel.render(60).join("\n"), /s saves - esc or enter closes/);
  });
});
