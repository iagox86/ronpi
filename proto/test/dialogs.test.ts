import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dialogAnswer, dialogPrompt } from "../dialogs.ts";

const confirm = { id: "1", method: "confirm", title: "Run rm?", message: "rm -rf x" };
const select = { id: "2", method: "select", title: "Pick", options: ["a", "b", "c"] };

describe("dialogAnswer", () => {
  it("answers confirm dialogs with y and n only", () => {
    assert.deepEqual(dialogAnswer(confirm, "y"), { confirmed: true });
    assert.deepEqual(dialogAnswer(confirm, "n"), { confirmed: false });
    assert.equal(dialogAnswer(confirm, "x"), null);
  });

  it("picks select options by 1-based digit", () => {
    assert.deepEqual(dialogAnswer(select, "2"), { value: "b" });
    assert.equal(dialogAnswer(select, "4"), null);
    assert.equal(dialogAnswer(select, "0"), null);
  });

  it("cancels a select dialog with escape", () => {
    assert.deepEqual(dialogAnswer(select, "\x1b"), { cancelled: true });
  });

  it("does not answer dialogs it cannot render", () => {
    assert.equal(dialogAnswer({ id: "3", method: "input" }, "y"), null);
  });
});

describe("dialogPrompt", () => {
  it("shows the title, message and answer keys for confirm", () => {
    assert.equal(dialogPrompt(confirm), "PERMISSION: Run rm? - rm -rf x  [y]es [n]o");
  });

  it("numbers the options for select", () => {
    assert.equal(dialogPrompt(select), "PERMISSION: Pick  1:a  2:b  3:c");
  });
});
