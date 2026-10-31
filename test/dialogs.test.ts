import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DIALOG_GUARD_MS, DialogPanel, dialogAnswer, dialogLines, dialogPrompt, grantGuarded, isTypingKey, withOrigin } from "../src/dialogs.ts";

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

  it("names the session that raised the dialog, with its numeric id", () => {
    const labeled = withOrigin(perm, 3, "Worker");
    assert.equal(labeled.origin, "Session 3 'Worker'");
    assert.match(dialogLines(labeled, 0, 100).join("\n"), /Session 3 'Worker': Permission Required/);
    assert.match(dialogPrompt(labeled), /PERMISSION pending \(Session 3 'Worker'\)/);
  });

  it("falls back to the id alone for unnamed sessions", () => {
    const labeled = withOrigin(perm, 7);
    assert.equal(labeled.origin, "Session 7");
    assert.match(dialogLines(labeled, 0, 100).join("\n"), /Session 7: Permission Required/);
  });

  it("leaves unlabelled dialogs unchanged", () => {
    assert.doesNotMatch(dialogLines(perm, 0, 100).join("\n"), /Session/);
    assert.equal(dialogPrompt(perm), "PERMISSION pending - up/down choose, enter or 1-9 answer, tab reason, esc deny");
  });
});

describe("modal permission prompt", () => {
  const perm = { id: "9", method: "select", options: ["Yes", "No"], shownAt: 1000 };

  it("ignores a grant in the first moments after the prompt appears, so typing cannot allow it", () => {
    assert.equal(grantGuarded(perm, { value: "Yes" }, 1000 + DIALOG_GUARD_MS - 1), true);
    assert.equal(grantGuarded(perm, { value: "Yes" }, 1000 + DIALOG_GUARD_MS), false);
    assert.equal(grantGuarded({ ...confirm, shownAt: 1000 }, { confirmed: true }, 1100), true);
  });

  it("always lets a deny through", () => {
    assert.equal(grantGuarded(perm, { value: "No" }, 1001), false);
    assert.equal(grantGuarded({ ...confirm, shownAt: 1000 }, { confirmed: false }, 1001), false);
  });

  it("does not guard a dialog with no arrival time", () => {
    assert.equal(grantGuarded({ ...perm, shownAt: undefined }, { value: "Yes" }, 1001), false);
  });

  it("stamps the arrival time when labelling a request", () => {
    assert.ok((withOrigin(select, 1).shownAt ?? 0) > 0);
  });

  it("treats text and enter as typing, but not escape sequences or control chords", () => {
    assert.equal(isTypingKey("a"), true);
    assert.equal(isTypingKey("\r"), true);
    assert.equal(isTypingKey("\x7f"), true);
    assert.equal(isTypingKey("\x1b[A"), false);
    assert.equal(isTypingKey("\x03"), false);
  });
});
