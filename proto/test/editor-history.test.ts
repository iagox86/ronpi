import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configureEditorKeys, InputEditor } from "../editor.ts";
import { selectListTheme } from "../pi-theme.ts";

function editor(): InputEditor {
  configureEditorKeys();
  const tui = { requestRender() {}, terminal: { rows: 24, columns: 80 } };
  return new InputEditor(tui as never, { borderColor: (s: string) => s, selectList: selectListTheme }, { paddingX: 1 });
}

const UP = "\x1b[A";

describe("editor history", () => {
  it("recalls seeded messages newest first with up", () => {
    const e = editor();
    e.setHistory(["first", "second", "third"]);
    e.handleInput(UP);
    assert.equal(e.getText(), "third");
    e.handleInput(UP);
    assert.equal(e.getText(), "second");
  });

  it("replaces, not appends to, earlier history", () => {
    const e = editor();
    e.setHistory(["old"]);
    e.setHistory(["new"]);
    e.handleInput(UP);
    assert.equal(e.getText(), "new");
    e.handleInput(UP);
    assert.equal(e.getText(), "new", "nothing older remains");
  });

  it("keeps messages submitted afterwards on top", () => {
    const e = editor();
    e.setHistory(["seeded"]);
    e.addToHistory("typed later");
    e.handleInput(UP);
    assert.equal(e.getText(), "typed later");
  });
});
