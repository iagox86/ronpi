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
const DOWN = "\x1b[B";

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

  it("moves up through multi-line text before going to history", () => {
    const e = editor();
    e.setHistory(["old message"]);
    e.setText("line one\nline two\nline three");
    e.handleInput(UP);
    assert.equal(e.getCursor().line, 1);
    e.handleInput(UP);
    assert.equal(e.getCursor().line, 0);
    assert.equal(e.getText(), "line one\nline two\nline three", "still the draft");
    e.handleInput(UP);
    assert.equal(e.getText(), "old message", "from the top line, up goes to the previous message");
  });

  it("brings the draft back with down after browsing history", () => {
    const e = editor();
    e.setHistory(["old message"]);
    e.setText("my draft");
    e.handleInput(UP);
    assert.equal(e.getText(), "old message");
    e.handleInput(DOWN);
    assert.equal(e.getText(), "my draft");
  });

  it("moves down through a recalled multi-line message, then on to the next entry", () => {
    const e = editor();
    e.setHistory(["first", "a\nb"]);
    e.handleInput(UP);
    assert.equal(e.getText(), "a\nb");
    assert.equal(e.getCursor().line, 0);
    e.handleInput(DOWN);
    assert.equal(e.getCursor().line, 1, "down moved within the message");
    assert.equal(e.getText(), "a\nb");
    e.handleInput(DOWN);
    assert.equal(e.getText(), "", "from the bottom line, down leaves history for the draft");
  });

  it("does not browse history with down when not already browsing", () => {
    const e = editor();
    e.setHistory(["old"]);
    e.setText("draft");
    e.handleInput(DOWN);
    assert.equal(e.getText(), "draft");
  });
});
