import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type SwitcherSession, Switcher } from "../src/switcher.ts";

const session = (key: string, group: string | undefined, state: SwitcherSession["state"] = "idle"): SwitcherSession =>
  ({ key, name: key, group, state, age: "1h", ageMs: 3600_000 }) as SwitcherSession;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function build(collapsed: string[]): Switcher {
  const sw = new Switcher();
  sw.groups = ["Work"];
  sw.sessions = [session("a", undefined), session("b", "Work"), session("c", "Work", "streaming")];
  sw.collapsed = new Set(collapsed);
  sw.refresh();
  return sw;
}

describe("switcher group folding", () => {
  it("shows a group's sessions under an open-arrow header", () => {
    const text = build([]).render(100).map(strip).join("\n");
    assert.match(text, /▾ Work/);
    assert.match(text, /\bb\b/);
  });

  it("hides a collapsed group's sessions and puts a summary next to its header", () => {
    const lines = build(["Work"]).render(100).map(strip);
    const header = lines.find((l) => l.includes("Work"));
    assert.match(header ?? "", /▸ Work\s+2 sessions - 1 working - 1 idle - newest 1h/);
    assert.ok(!lines.some((l) => /^\S*\s*[*·-]\s+b\b/.test(l)), "session b should be hidden");
  });

  it("keeps the hidden sessions in the order list so reordering does not forget them", () => {
    const sw = build(["Work"]);
    assert.deepEqual(sw.sessions.map((s) => s.key), ["a", "b", "c"]);
  });

  it("moves the cursor to the header when its session gets hidden", () => {
    const sw = build([]);
    sw.selectedKey = "b";
    sw.refresh();
    sw.collapsed = new Set(["Work"]);
    sw.refresh();
    assert.equal(sw.current(), undefined);
    assert.equal(sw.currentHeaderTitle(), "Work");
  });

  it("shows every session while a filter is on", () => {
    const sw = build(["Work"]);
    sw.filterNote = "filter: x";
    sw.refresh();
    assert.match(sw.render(100).map(strip).join("\n"), /\bb\b/);
  });

  it("tells whether the highlighted header is folded, and nothing for a session row", () => {
    const sw = build(["Work"]);
    assert.equal(sw.currentHeaderFolded(), undefined); // the cursor starts on session a
    sw.move(1); // the Work header, folded
    assert.equal(sw.currentHeaderFolded(), true);
    const open = build([]);
    open.move(1);
    assert.equal(open.currentHeaderFolded(), false);
  });

  it("gives an empty group the same arrow and a bold title, so it cannot pass for a session", () => {
    const sw = new Switcher();
    sw.groups = ["Empty"];
    sw.sessions = [session("a", undefined)];
    sw.refresh();
    const line = sw.render(60).find((l) => strip(l).includes("Empty")) ?? "";
    assert.match(strip(line), /\u25be Empty/);
    assert.ok(line.includes("\x1b[1m"), "header should be bold");
  });
});
