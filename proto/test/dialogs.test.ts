import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DialogPanel, dialogAnswer, dialogLines, dialogPrompt } from "../dialogs.ts";

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

  it("answers the highlighted option on enter", () => {
    assert.deepEqual(dialogAnswer(select, "\r", 2), { value: "c" });
  });

  it("treats escape on a permission select as the explicit deny option", () => {
    const perm = { id: "4", method: "select", options: ["Yes", "Yes, for this session", "No", "No, provide reason"] };
    assert.deepEqual(dialogAnswer(perm, "\x1b"), { value: "No" });
  });

  it("denies via the last option when none starts with No", () => {
    assert.deepEqual(dialogAnswer(select, "\x1b"), { value: "c" });
  });

  it("treats escape on a confirm dialog as no", () => {
    assert.deepEqual(dialogAnswer(confirm, "\x1b"), { confirmed: false });
  });

  it("leaves free-text dialogs to the input box", () => {
    assert.equal(dialogAnswer({ id: "3", method: "input" }, "y"), null);
  });
});

describe("dialog rendering", () => {
  const perm = {
    id: "5",
    method: "select",
    title: "Permission Required\ntool    : bash\nrule    : sudo *\ncommand : sudo -V",
    options: ["Yes", 'Yes, allow bash "sudo -V" for this session', "No"],
  };

  it("shows every title line and the full option strings", () => {
    const text = dialogLines(perm, 0, 100).join("\n");
    assert.match(text, /rule {4}: sudo \*/);
    assert.match(text, /command : sudo -V/);
    assert.match(text, /2\. Yes, allow bash "sudo -V" for this session/);
  });

  it("keeps the status hint to one short line", () => {
    assert.doesNotMatch(dialogPrompt(perm), /\n/);
  });

  it("moves the highlight within the options and resets for a new dialog", () => {
    const panel = new DialogPanel();
    panel.sync(perm);
    panel.move(1);
    panel.move(1);
    panel.move(1);
    assert.equal(panel.highlighted, 2);
    panel.sync({ ...perm, id: "6" });
    assert.equal(panel.highlighted, 0);
  });

  it("shows the placeholder and how to skip for free-text dialogs", () => {
    const text = dialogLines({ id: "7", method: "input", title: "Why?", placeholder: "Reason shown back" }, 0, 100).join("\n");
    assert.match(text, /Reason shown back/);
    assert.match(text, /esc skips/);
  });

  it("offers an inline reason on the reason option and shows what is typed", () => {
    const withReason = { ...perm, options: ["Yes", "No", "No, provide reason"] };
    assert.match(dialogLines(withReason, 2, 100).join("\n"), /tab: type a reason/);
    assert.doesNotMatch(dialogLines(withReason, 1, 100).join("\n"), /tab: type a reason/);
    assert.match(dialogLines(withReason, 2, 100, "too risky").join("\n"), /No, provide reason: too risky/);
  });

  it("renders nothing without a dialog", () => {
    const panel = new DialogPanel();
    panel.sync(undefined);
    assert.deepEqual(panel.render(80), []);
  });
});
