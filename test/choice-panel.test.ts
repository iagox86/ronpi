import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChoicePanel } from "../src/choice-panel.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const MODELS = ["zai/glm-5.3-flash", "zai/glm-5.3", "anthropic/claude-opus"];

function open(current?: string): { panel: ChoicePanel; picked: string[] } {
  const panel = new ChoicePanel();
  const picked: string[] = [];
  panel.open("Switch model", MODELS, current, (c) => picked.push(c));
  return { panel, picked };
}

describe("choice panel", () => {
  it("starts on the current choice and picks the highlighted one on enter", () => {
    const { panel, picked } = open("zai/glm-5.3");
    panel.keys("\r");
    assert.deepEqual(picked, ["zai/glm-5.3"]);
    assert.equal(panel.isOpen, false);
  });

  it("moves with up and down, staying within the list", () => {
    const { panel, picked } = open();
    panel.keys("\x1b[B");
    panel.keys("\x1b[B");
    panel.keys("\x1b[B");
    panel.keys("\r");
    assert.deepEqual(picked, ["anthropic/claude-opus"]);
  });

  it("narrows the list as words are typed and picks from what is left", () => {
    const { panel, picked } = open();
    for (const ch of "claude") {
      panel.keys(ch);
    }
    const text = panel.render(100).map(strip).join("\n");
    assert.match(text, /claude-opus/);
    assert.doesNotMatch(text, /glm/);
    panel.keys("\r");
    assert.deepEqual(picked, ["anthropic/claude-opus"]);
  });

  it("does nothing on enter when nothing matches", () => {
    const { panel, picked } = open();
    panel.keys("q");
    panel.keys("q");
    panel.keys("\r");
    assert.deepEqual(picked, []);
    assert.equal(panel.isOpen, true);
    assert.match(panel.render(100).map(strip).join("\n"), /no matches/);
  });

  it("closes on escape without picking", () => {
    const { panel, picked } = open();
    panel.keys("\x1b");
    assert.equal(panel.isOpen, false);
    assert.deepEqual(picked, []);
  });

  it("marks the current choice", () => {
    const text = open("zai/glm-5.3").panel.render(100).map(strip).join("\n");
    assert.match(text, /> \* zai\/glm-5\.3\b/);
  });
});
