import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GroupsFile } from "../src/groups.ts";
import { pruneStale } from "../src/groups.ts";
import { type Lineage, parentMap } from "../src/lineage.ts";
import { moveSession } from "../src/session-list.ts";
import { arrangeTree, bannerText, childCost, childNote, descendantIds, relationOf, visibleRows } from "../src/session-tree.ts";
import { buildStatusLine } from "../src/status.ts";
import { Switcher, type SwitcherSession } from "../src/switcher.ts";

const row = (id: string, over: Partial<SwitcherSession> = {}): SwitcherSession =>
  ({ key: id, name: id, state: "idle", sessionId: id, age: "1h", ageMs: 3600_000, ...over }) as SwitcherSession;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const keys = (l: SwitcherSession[]) => l.map((s) => s.key);

describe("arrangeTree", () => {
  it("puts each child right under its parent, indented, in the parent's group", () => {
    const list = [row("a", { group: "G" }), row("b"), row("a1", { group: undefined }), row("a2"), row("a1x")];
    const out = arrangeTree(list, new Map([["a1", "a"], ["a2", "a"], ["a1x", "a1"]]));
    assert.deepEqual(keys(out), ["a", "a1", "a1x", "a2", "b"]);
    assert.deepEqual(out.map((s) => s.depth), [0, 1, 2, 1, 0]);
    assert.deepEqual(out.map((s) => s.group), ["G", "G", "G", "G", undefined]);
    assert.deepEqual([out[0]?.descendants, out[1]?.descendants, out[4]?.descendants], [3, 1, 0]);
  });

  it("counts working and parked descendants", () => {
    const list = [row("a"), row("k1", { state: "streaming" }), row("k2", { parked: true }), row("k3", { state: "compacting" })];
    const [a] = arrangeTree(list, new Map([["k1", "a"], ["k2", "a"], ["k3", "a"]]));
    assert.deepEqual([a?.descendantsWorking, a?.descendantsParked], [2, 1]);
    assert.equal(childNote(a as SwitcherSession), "3 children, 2 working, 1 parked");
    assert.equal(childNote(row("solo")), "");
  });

  it("leaves a session top-level when its parent is not listed or the links form a cycle", () => {
    const out = arrangeTree([row("x"), row("y"), row("lost")], new Map([["x", "y"], ["y", "x"], ["lost", "gone"]]));
    assert.deepEqual(out.map((s) => s.depth), [0, 0, 0]);
    assert.deepEqual(keys(out), ["x", "y", "lost"]);
  });
});

describe("visibleRows", () => {
  const tree = () => arrangeTree([row("a"), row("k1"), row("k1x"), row("k2", { parked: true }), row("b")], new Map([["k1", "a"], ["k1x", "k1"], ["k2", "a"]]));

  it("hides everything under a folded parent", () => {
    assert.deepEqual(keys(visibleRows(tree(), new Set(["a"]), false)), ["a", "b"]);
    assert.deepEqual(keys(visibleRows(tree(), new Set(["k1"]), false)), ["a", "k1", "b"].filter((k) => k !== "b").concat(["b"]).filter((k) => k !== "k2"));
  });

  it("hides parked children unless a filter is on", () => {
    assert.deepEqual(keys(visibleRows(tree(), new Set(), false)), ["a", "k1", "k1x", "b"]);
    assert.deepEqual(keys(visibleRows(tree(), new Set(["a"]), true)), ["a", "k1", "k1x", "k2", "b"]);
  });

  it("never hides a parked top-level session", () => {
    assert.deepEqual(keys(visibleRows([row("p", { parked: true })], new Set(), false)), ["p"]);
  });
});

describe("lineage helpers", () => {
  const ref = (id: string) => ({ id, name: id, file: `/${id}` });
  const lineage: Lineage = {
    p: { forks: [ref("c1"), ref("c2")] },
    c1: { parent: ref("p"), kind: "subagent", forks: [ref("g")] },
    c2: { parent: ref("p"), kind: "subagent" },
    g: { parent: ref("c1"), kind: "subagent" },
    userfork: { parent: ref("p") },
  };

  it("maps agent-started children to parents and finds relations", () => {
    assert.deepEqual([...parentMap(lineage)], [["c1", "p"], ["c2", "p"], ["g", "c1"]]);
    assert.deepEqual(relationOf(lineage, "c1"), { kind: "subagent", parentId: "p", parentName: "p" });
    assert.equal(relationOf(lineage, "p"), undefined);
    assert.equal(relationOf(lineage, "userfork"), undefined, "a copy the user made is not shown as a child");
    assert.equal(relationOf(lineage, undefined), undefined);
  });

  it("sums the spend of everything below, once each, even with a cycle", () => {
    lineage.p?.forks?.push(ref("userfork"));
    assert.deepEqual(descendantIds(lineage, "p").sort(), ["c1", "c2", "g"]);
    assert.equal(childCost(lineage, "p", () => 0.5), 1.5);
    const loop: Lineage = { a: { forks: [ref("b")] }, b: { kind: "subagent", forks: [ref("a")] }, };
    assert.deepEqual(descendantIds(loop, "a"), ["b"]);
  });

  it("words the banner", () => {
    assert.match(bannerText({ kind: "subagent", parentId: "p", parentName: "p" }, "Plan"), /^SUBAGENT of Plan/);
  });
});

describe("moving a parent", () => {
  const groups = (): GroupsFile => ({ groups: ["G"], assignments: {} });
  const list = () => arrangeTree([row("a"), row("a1"), row("b"), row("c")], new Map([["a1", "a"]]));

  it("moves the whole block past the neighbour", () => {
    const g = groups();
    const res = moveSession(g, list(), list()[0] as SwitcherSession, 1);
    assert.equal(res.changed, true);
    assert.deepEqual(g.order, ["b", "a", "a1", "c"]);
  });

  it("carries the children into the group the parent crosses into", () => {
    const g = groups();
    const l = arrangeTree([row("a"), row("a1"), row("x", { group: "G" })], new Map([["a1", "a"]]));
    moveSession(g, l, l[0] as SwitcherSession, 1);
    assert.equal(g.assignments.a, "G");
    assert.equal(g.assignments.a1, "G");
    assert.deepEqual(g.order, ["a", "a1", "x"]);
  });

  it("refuses to move a child on its own and says why", () => {
    const l = list();
    const res = moveSession(groups(), l, l[1] as SwitcherSession, 1);
    assert.equal(res.changed, false);
    assert.match(res.hint ?? "", /move the parent/);
  });
});

describe("fold state", () => {
  it("is kept when the folded session still exists and dropped when it is gone", () => {
    const data: GroupsFile = { groups: ["G"], assignments: {}, collapsed: ["G", "gone-group", "alive", "dead"] };
    pruneStale(data, new Set(["alive"]));
    assert.deepEqual(data.collapsed, ["G", "alive"]);
  });
});

describe("switcher tree rows", () => {
  function build(folded: string[] = [], filter = ""): Switcher {
    const sw = new Switcher();
    sw.sessions = arrangeTree([row("parent", { state: "streaming" }), row("kid", { state: "idle" }), row("parkedkid", { parked: true })], new Map([["kid", "parent"], ["parkedkid", "parent"]]));
    sw.collapsed = new Set(folded);
    sw.filterNote = filter;
    sw.refresh();
    return sw;
  }
  const text = (sw: Switcher) => sw.render(120).map(strip);

  it("indents children under an open parent that says what is below it", () => {
    const lines = text(build());
    assert.ok(lines.some((l) => /▾ parent\b.*2 children, 1 parked/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /└ kid\b/.test(l)));
    assert.ok(!lines.some((l) => l.includes("parkedkid")), "parked children are hidden");
  });

  it("hides the children of a folded parent and moves the cursor onto it", () => {
    const sw = build();
    sw.selectedKey = "kid";
    sw.refresh();
    sw.collapsed = new Set(["parent"]);
    sw.refresh();
    const lines = text(sw);
    assert.ok(lines.some((l) => /▸ parent\b/.test(l)));
    assert.ok(!lines.some((l) => /└ kid/.test(l)));
    assert.equal(sw.current()?.key, "parent");
  });

  it("shows parked children and ignores folds while a filter is on", () => {
    const lines = text(build(["parent"], "filter: x"));
    assert.ok(lines.some((l) => l.includes("parkedkid")));
    assert.ok(lines.some((l) => /└ kid/.test(l)));
  });

  it("selectSessionId moves the highlight to a row", () => {
    const sw = build();
    sw.selectSessionId("parent");
    assert.equal(sw.current()?.key, "parent");
  });
});

describe("status line for a child", () => {
  const meta = { id: 1, cwd: "/", model: "m/x", messageCount: 0, streaming: false, compacting: false, dead: false, active: true, pendingDialog: false, attachedToYou: true, attachedElsewhere: false, sessionName: "kid" };
  it("says whose child it is and what its own children cost", () => {
    const line = strip(
      buildStatusLine({
        switcherOpen: false,
        viewing: "/k",
        stats: { total: 1, running: 0, waiting: 0, cost: 0, tokens: 0 } as never,
        flash: "",
        meta: meta as never,
        relation: { kind: "subagent", parentName: "Boss" },
        childCost: 0.25,
      }),
    );
    assert.match(line, /SUBAGENT of Boss/);
    assert.match(line, /\+\$0\.25 children/);
  });
});
