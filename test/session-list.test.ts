import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GroupsFile } from "../src/groups.ts";
import {
  appendUnranked,
  buildSessionList,
  deleteEmptyGroup,
  displayName,
  type LocalSession,
  moveGroup,
  moveSession,
  sessionKey,
  sortSessions,
  groupTldr,
} from "../src/session-list.ts";
import type { SessionMeta } from "../src/shared.ts";
import type { SwitcherSession } from "../src/switcher.ts";

const NOW = 1_000_000_000_000;

function local(file: string, over: Partial<LocalSession> = {}): LocalSession {
  return {
    path: file,
    id: `uuid-${file}`,
    cwd: "/work/proj",
    firstMessage: "",
    lastActivity: "",
    modified: NOW - 60_000,
    ...over,
  };
}

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 1,
    cwd: "/work/proj",
    model: "prov/model-x",
    messageCount: 0,
    streaming: false,
    dead: false,
    active: true,
    pendingDialog: false,
    attachedToYou: false,
    attachedElsewhere: false,
    ...over,
  };
}

function build(opts: { daemon?: SessionMeta[]; files?: LocalSession[]; groups?: GroupsFile; summaries?: Map<string, string> }) {
  return buildSessionList({
    daemon: opts.daemon ?? [],
    local: new Map((opts.files ?? []).map((l) => [l.path, l])),
    groups: opts.groups ?? { groups: [], assignments: {} },
    summaries: opts.summaries ?? new Map(),
    now: NOW,
  });
}

describe("sessionKey", () => {
  it("is the session file when known, else a daemon-local id", () => {
    assert.equal(sessionKey(meta({ sessionFile: "/a.jsonl" })), "/a.jsonl");
    assert.equal(sessionKey(meta({ id: 7 })), "daemon:7");
  });
});

describe("displayName", () => {
  it("prefers the live name, then the file name, then the first message", () => {
    const info = local("/a", { name: "from file", firstMessage: "first words" });
    assert.equal(displayName(meta({ sessionName: "live" }), info), "live");
    assert.equal(displayName(meta(), info), "from file");
    assert.equal(displayName(undefined, local("/a", { firstMessage: "first words" })), "first words");
    assert.equal(displayName(undefined, local("/a")), "<unnamed>");
  });

  it("renders a bang-first first message as the command, not the wrapper", () => {
    const wrapped = `<local-command-caveat>The user ran this.</local-command-caveat>\n<local-command>cat /etc/passwd</local-command>\n<local-command-output exit="0">root</local-command-output>`;
    assert.equal(displayName(undefined, local("/b", { firstMessage: wrapped })), "$ cat /etc/passwd");
  });
});

describe("buildSessionList", () => {
  it("merges a daemon session and its file into one row", () => {
    const rows = build({
      daemon: [meta({ sessionFile: "/a.jsonl", sessionId: "uuid-/a.jsonl", streaming: true })],
      files: [local("/a.jsonl", { name: "alpha" })],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "streaming");
    assert.equal(rows[0].name, "alpha");
    assert.equal(rows[0].daemonId, 1);
    assert.equal(rows[0].model, "model-x");
  });

  it("lists file-only sessions as inactive", () => {
    const rows = build({ files: [local("/a.jsonl")] });
    assert.equal(rows[0].state, "inactive");
    assert.equal(rows[0].daemonId, undefined);
  });

  it("marks a crashed child dead with a respawn note", () => {
    const rows = build({ daemon: [meta({ sessionFile: "/a", dead: true })], files: [local("/a")] });
    assert.equal(rows[0].state, "dead");
    assert.match(rows[0].note ?? "", /crashed/);
  });

  it("tags sessions live in another pi as muted with an adopt note", () => {
    const rows = build({ daemon: [meta({ id: -1, sessionFile: "/a", externallyLive: true, active: false })], files: [local("/a")] });
    assert.equal(rows[0].muted, true);
    assert.match(rows[0].description ?? "", /adopt/);
  });

  it("hides an externally live session whose file is not on disk yet", () => {
    const rows = build({ daemon: [meta({ id: -1, sessionFile: "/unwritten", externallyLive: true, active: false })] });
    assert.deepEqual(rows, []);
  });

  it("keeps a daemon-only session that has no file yet", () => {
    const rows = build({ daemon: [meta({ id: 3 })] });
    assert.equal(rows[0].key, "daemon:3");
  });

  it("prioritizes a permission wait over other notes", () => {
    const rows = build({ daemon: [meta({ sessionFile: "/a", pendingDialog: true, attachedElsewhere: true })], files: [local("/a")] });
    assert.equal(rows[0].note, "waiting on permission");
  });

  it("assigns the group from the session id", () => {
    const rows = build({
      files: [local("/a")],
      groups: { groups: ["work"], assignments: { "uuid-/a": "work" } },
    });
    assert.equal(rows[0].group, "work");
  });

  it("describes a row with the live summary before the file's last activity", () => {
    const files = [local("/a", { lastActivity: "from file" })];
    assert.equal(build({ files })[0].description, "from file");
    assert.equal(build({ files, summaries: new Map([["/a", "live"]]) })[0].description, "live");
  });

  it("prefers a saved summary over the live last message", () => {
    const files = [local("/a", { id: "u-a", lastActivity: "from file" })];
    const groups = { groups: [], assignments: {}, summaries: { "u-a": { text: "saved", messages: 2, at: "t", model: "m" } } };
    assert.equal(build({ files, groups, summaries: new Map([["/a", "live"]]) })[0].description, "saved");
  });

  it("falls back to the project directory for unnamed sessions", () => {
    assert.equal(build({ files: [local("/a")] })[0].description, "proj");
  });
});

describe("sortSessions", () => {
  const rows = (...keys: string[]): SwitcherSession[] =>
    keys.map((k) => ({ key: k, name: k, state: "inactive", sessionId: `id-${k}` }));

  it("puts manually ordered sessions first, in manual order", () => {
    const list = rows("a", "b", "c");
    sortSessions(list, ["id-c", "id-a"], ["a", "b", "c"]);
    assert.deepEqual(list.map((s) => s.key), ["c", "a", "b"]);
  });

  it("orders unplaced sessions by the order captured when the switcher opened", () => {
    const list = rows("a", "b", "c");
    sortSessions(list, [], ["c", "a", "b"]);
    assert.deepEqual(list.map((s) => s.key), ["c", "a", "b"]);
  });

  it("sorts sessions that appeared after opening to the bottom", () => {
    const list = rows("new", "a");
    sortSessions(list, [], ["a"]);
    assert.deepEqual(list.map((s) => s.key), ["a", "new"]);
  });
});

describe("moveSession", () => {
  const row = (id: string, group?: string): SwitcherSession => ({ key: id, name: id, state: "inactive", sessionId: id, group });
  const names = (g: GroupsFile) => g.order;

  it("swaps with the neighbor inside a section", () => {
    const groups: GroupsFile = { groups: [], assignments: {} };
    const list = [row("a"), row("b"), row("c")];
    const res = moveSession(groups, list, list[0], 1);
    assert.equal(res.changed, true);
    assert.deepEqual(names(groups), ["b", "a", "c"]);
  });

  it("moves into the next group when crossing the end of a section", () => {
    const groups: GroupsFile = { groups: ["g"], assignments: { c: "g" } };
    const list = [row("a"), row("b"), row("c", "g")];
    moveSession(groups, list, list[1], 1);
    assert.equal(groups.assignments.b, "g");
    assert.deepEqual(names(groups), ["a", "b", "c"]);
  });

  it("moves into the previous section when crossing upward, landing last", () => {
    const groups: GroupsFile = { groups: ["g"], assignments: { c: "g" } };
    const list = [row("a"), row("c", "g")];
    moveSession(groups, list, list[1], -1);
    assert.equal(groups.assignments.c, null);
    assert.deepEqual(names(groups), ["a", "c"]);
  });

  it("can move into an empty group", () => {
    const groups: GroupsFile = { groups: ["empty"], assignments: {} };
    const list = [row("a")];
    moveSession(groups, list, list[0], 1);
    assert.equal(groups.assignments.a, "empty");
  });

  it("reports the edges instead of moving", () => {
    const groups: GroupsFile = { groups: [], assignments: {} };
    const list = [row("a")];
    assert.deepEqual(moveSession(groups, list, list[0], 1), { changed: false, hint: "already at the bottom" });
    assert.deepEqual(moveSession(groups, list, list[0], -1), { changed: false, hint: "already at the top" });
  });

  it("does nothing for a session without an id", () => {
    const groups: GroupsFile = { groups: [], assignments: {} };
    const s: SwitcherSession = { key: "k", name: "k", state: "inactive" };
    assert.equal(moveSession(groups, [s], s, 1).changed, false);
  });
});

describe("moveGroup", () => {
  it("swaps a group with its neighbor", () => {
    const groups: GroupsFile = { groups: ["a", "b", "c"], assignments: {} };
    assert.equal(moveGroup(groups, "a", 1).changed, true);
    assert.deepEqual(groups.groups, ["b", "a", "c"]);
  });

  it("stops at the ends", () => {
    const groups: GroupsFile = { groups: ["a", "b"], assignments: {} };
    assert.equal(moveGroup(groups, "a", -1).hint, "already the first group");
    assert.equal(moveGroup(groups, "b", 1).hint, "already the last group");
    assert.deepEqual(groups.groups, ["a", "b"]);
  });
});

describe("deleteEmptyGroup", () => {
  it("refuses to delete a group that still has sessions", () => {
    const groups: GroupsFile = { groups: ["g"], assignments: { a: "g" } };
    const list: SwitcherSession[] = [{ key: "a", name: "a", state: "inactive", group: "g" }];
    const res = deleteEmptyGroup(groups, list, "g");
    assert.equal(res.changed, false);
    assert.match(res.hint ?? "", /1 session /);
    assert.deepEqual(groups.groups, ["g"]);
  });

  it("deletes an empty group and tombstones stale assignments to it", () => {
    const groups: GroupsFile = { groups: ["g", "h"], assignments: { gone: "g", other: "h" } };
    assert.equal(deleteEmptyGroup(groups, [], "g").changed, true);
    assert.deepEqual(groups.groups, ["h"]);
    assert.equal(groups.assignments.gone, null);
    assert.equal(groups.assignments.other, "h");
  });

  it("never deletes the ungrouped section", () => {
    const groups: GroupsFile = { groups: [], assignments: {} };
    assert.equal(deleteEmptyGroup(groups, [], "(ungrouped)").changed, false);
  });
});

describe("appendUnranked", () => {
  const row = (sessionId?: string) => ({ sessionId }) as SwitcherSession;
  it("puts sessions the order does not know at the end, in display order", () => {
    assert.deepEqual(appendUnranked(["a", "b"], [row("c"), row("a"), row("d"), row("b")]), ["a", "b", "c", "d"]);
  });
  it("ranks everything on first run and ignores rows without an id", () => {
    assert.deepEqual(appendUnranked(undefined, [row("x"), row(), row("y")]), ["x", "y"]);
  });
  it("reports no change when the order is complete", () => {
    assert.equal(appendUnranked(["a"], [row("a"), row()]), null);
  });
});

describe("parked sessions", () => {
  const file = local("/a.jsonl", { modified: NOW - 3600_000 });

  it("drop out of the recent colour once parked", () => {
    const [recent] = build({ files: [file] });
    const [parked] = build({ files: [file], groups: { groups: [], assignments: {}, parked: { [file.id]: NOW - 60_000 } } });
    assert.equal(recent?.parked, false);
    assert.equal(parked?.parked, true);
    assert.equal(parked?.ageMs, undefined);
    assert.equal(parked?.age, recent?.age);
  });

  it("are recent again once the session has been used after the mark", () => {
    const [row] = build({ files: [file], groups: { groups: [], assignments: {}, parked: { [file.id]: NOW - 2 * 3600_000 } } });
    assert.equal(row?.parked, false);
    assert.equal(row?.ageMs, 3600_000);
  });
});

describe("groupTldr", () => {
  const row = (state: SwitcherSession["state"], age: string, ageMs: number) => ({ key: age, name: age, state, age, ageMs }) as SwitcherSession;

  it("counts sessions, what they are doing, and the newest age", () => {
    const text = groupTldr([row("idle", "3h", 3 * 3600_000), row("streaming", "5m", 300_000), row("inactive", "9d", 9 * 86_400_000)]);
    assert.equal(text, "3 sessions - 1 working - 1 idle - newest 5m");
  });

  it("speaks of a single session in the singular and leaves out empty parts", () => {
    assert.equal(groupTldr([row("inactive", "2d", 2 * 86_400_000)]), "1 session - newest 2d");
    assert.equal(groupTldr([]), "empty");
  });
});

describe("session comments", () => {
  it("reach the row by session id but do not replace the description", () => {
    const groups: GroupsFile = { groups: [], assignments: {}, comments: { "uuid-/a.jsonl": "remind me why" } };
    const [row] = build({ files: [local("/a.jsonl")], groups });
    assert.equal(row?.comment, "remind me why");
    assert.notEqual(row?.description, "remind me why");
  });
});
