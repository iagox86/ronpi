import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadGroups, saveGroups } from "../src/groups.ts";
import { SwitcherActions } from "../src/switcher-actions.ts";
import { Switcher } from "../src/switcher.ts";

const CTRL_X = "\x18";
let dir: string;
const saved = process.env.XDG_DATA_HOME;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-sw-"));
  process.env.XDG_DATA_HOME = dir;
});

afterEach(() => {
  process.env.XDG_DATA_HOME = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A switcher over one ungrouped session, a group holding one session, and an empty group. */
function setup() {
  saveGroups({ groups: ["Full", "Empty"], assignments: { a: null, b: "Full" } });
  const sw = new Switcher();
  const local = new Map(
    ["a", "b"].map((id) => [`/s/${id}.jsonl`, { path: `/s/${id}.jsonl`, id, cwd: "/w", firstMessage: id, lastActivity: "", modified: Date.now() - 3600_000, name: id }]),
  );
  const host = {
    tui: { requestRender() {}, terminal: { rows: 30 } },
    editor: { getText: () => "", setText() {} },
    switcher: sw,
    sessions: new Map(),
    local,
    views: new Map(),
    summaries: new Map(),
    viewing: null,
    send() {},
    notify() {},
    request: async () => ({}),
    metaForPath: () => undefined,
  };
  const actions = new SwitcherActions(host as never);
  (host as { switching?: unknown }).switching = actions;
  actions.refresh();
  const goTo = (title: string) => {
    for (let i = 0; i < 10 && !(sw.currentIsHeader() && sw.currentHeaderTitle() === title); i++) {
      sw.move(1);
    }
    assert.equal(sw.currentHeaderTitle(), title);
  };
  return { sw, actions, goTo };
}

describe("deleting a group", () => {
  it("asks for a second ctrl-x before deleting an empty group", () => {
    const { sw, actions, goTo } = setup();
    goTo("Empty");
    actions.keys(CTRL_X);
    assert.match(sw.hint, /ctrl-x again to delete this group/);
    assert.ok(loadGroups().groups.includes("Empty"));
    actions.keys(CTRL_X);
    assert.ok(!loadGroups().groups.includes("Empty"));
  });

  it("explains why a group with sessions cannot be deleted, without arming it", () => {
    const { sw, actions, goTo } = setup();
    goTo("Full");
    actions.keys(CTRL_X);
    assert.doesNotMatch(sw.hint, /again/);
    actions.keys(CTRL_X);
    assert.ok(loadGroups().groups.includes("Full"));
  });
});
