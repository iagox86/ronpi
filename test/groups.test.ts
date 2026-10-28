import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { groupsFile, isParked, PARK_KEEP_MS, pruneStale, loadGroups, resolveGroup, saveGroups, withComment, withParked } from "../src/groups.ts";

let dir: string;
const saved = { data: process.env.XDG_DATA_HOME, agent: process.env.PI_CODING_AGENT_DIR };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-groups-"));
  process.env.XDG_DATA_HOME = path.join(dir, "data");
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
});

afterEach(() => {
  process.env.XDG_DATA_HOME = saved.data;
  process.env.PI_CODING_AGENT_DIR = saved.agent;
  if (saved.data === undefined) {
    delete process.env.XDG_DATA_HOME;
  }
  if (saved.agent === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadGroups / saveGroups", () => {
  it("starts empty when no file exists", () => {
    assert.deepEqual(loadGroups(), { groups: [], assignments: {} });
  });

  it("round-trips groups, assignments and manual order", () => {
    saveGroups({ groups: ["a"], assignments: { s1: "a", s2: null }, order: ["s2", "s1"] });
    assert.deepEqual(loadGroups(), { groups: ["a"], assignments: { s1: "a", s2: null }, order: ["s2", "s1"] });
  });

  it("adds any assigned group missing from the group list when saving", () => {
    saveGroups({ groups: [], assignments: { s1: "orphan" } });
    assert.deepEqual(loadGroups().groups, ["orphan"]);
  });

  it("merges case-insensitive duplicate group names, first casing winning", () => {
    fs.mkdirSync(path.dirname(groupsFile()), { recursive: true });
    fs.writeFileSync(groupsFile(), JSON.stringify({ groups: ["Ron", "ron"], assignments: { s1: "ron" } }));
    const loaded = loadGroups();
    assert.deepEqual(loaded.groups, ["Ron"]);
    assert.equal(loaded.assignments.s1, "Ron");
  });

  it("falls back to the legacy pi agent location for reading", () => {
    const legacy = path.join(process.env.PI_CODING_AGENT_DIR as string, "session-groups.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ groups: ["old"], assignments: {} }));
    assert.deepEqual(loadGroups().groups, ["old"]);
  });
});

describe("resolveGroup", () => {
  it("reuses an existing group case-insensitively", () => {
    const data = { groups: ["Work"], assignments: {} };
    assert.equal(resolveGroup(data, "  work "), "Work");
    assert.deepEqual(data.groups, ["Work"]);
  });

  it("appends a new group", () => {
    const data = { groups: [], assignments: {} };
    assert.equal(resolveGroup(data, "new"), "new");
    assert.deepEqual(data.groups, ["new"]);
  });

  it("rejects an empty name", () => {
    assert.throws(() => resolveGroup({ groups: [], assignments: {} }, "  "), /empty/);
  });
});

describe("groups file round trip", () => {
  it("keeps fields it does not know about, such as saved summaries", () => {
    const summaries = { abc: { text: "one line", messages: 3, at: "t", model: "m" } };
    fs.mkdirSync(path.dirname(groupsFile()), { recursive: true });
    fs.writeFileSync(groupsFile(), JSON.stringify({ groups: ["a"], assignments: {}, order: [], summaries, other: 1 }));
    saveGroups(loadGroups());
    const after = JSON.parse(fs.readFileSync(groupsFile(), "utf8"));
    assert.deepEqual(after.summaries, summaries);
    assert.equal(after.other, 1);
  });
});

describe("withParked", () => {
  it("marks a session parked at the given time without touching the original map", () => {
    const data = { groups: [], assignments: {}, parked: { a: 1 } };
    const next = withParked(data, "b", true, 99);
    assert.deepEqual(next, { a: 1, b: 99 });
    assert.deepEqual(data.parked, { a: 1 });
  });

  it("unparks, and a parked session counts as parked until its file changes", () => {
    const data = { groups: [], assignments: {}, parked: { a: 100 } };
    assert.ok(isParked(data, "a", 100));
    assert.ok(!isParked(data, "a", 101));
    assert.deepEqual(withParked(data, "a", false), {});
  });
});

describe("pruneStale", () => {
  const NOW = 1_800_000_000_000;

  it("forgets fold entries for groups that no longer exist but keeps (ungrouped)", () => {
    const data = { groups: ["A"], assignments: {}, collapsed: ["A", "Gone", "(ungrouped)"] };
    assert.ok(pruneStale(data, new Set(), NOW));
    assert.deepEqual(data.collapsed, ["A", "(ungrouped)"]);
  });

  it("forgets old park marks of vanished sessions but keeps recent ones and live ones", () => {
    const data = {
      groups: [],
      assignments: {},
      parked: { old_gone: NOW - PARK_KEEP_MS - 1, recent_gone: NOW - 1000, old_live: NOW - PARK_KEEP_MS - 1 },
    };
    assert.ok(pruneStale(data, new Set(["old_live"]), NOW));
    assert.deepEqual(Object.keys(data.parked).sort(), ["old_live", "recent_gone"]);
  });

  it("reports no change when there is nothing to forget", () => {
    assert.equal(pruneStale({ groups: ["A"], assignments: {}, collapsed: ["A"], parked: { s: NOW } }, new Set(["s"]), NOW), false);
  });
});

describe("legacy park marks", () => {
  it("are read from the old `done` key, and saved under `parked`", () => {
    fs.mkdirSync(path.dirname(groupsFile()), { recursive: true });
    fs.writeFileSync(groupsFile(), JSON.stringify({ groups: [], assignments: {}, done: { s: 5 } }));
    const loaded = loadGroups();
    assert.deepEqual(loaded.parked, { s: 5 });
    saveGroups(loaded);
    const onDisk = JSON.parse(fs.readFileSync(groupsFile(), "utf8"));
    assert.deepEqual(onDisk.parked, { s: 5 });
    assert.equal("done" in onDisk, false);
  });
});

describe("withComment", () => {
  it("sets, replaces and removes a comment without touching the original map", () => {
    const data = { groups: [], assignments: {}, comments: { a: "old" } };
    const set = withComment(data, "b", "  waiting on the vendor  ");
    assert.deepEqual(set, { a: "old", b: "waiting on the vendor" });
    assert.deepEqual(data.comments, { a: "old" });
    assert.deepEqual(withComment({ ...data, comments: set }, "a", ""), { b: "waiting on the vendor" });
  });

  it("survives pruning of stale sessions", () => {
    const data = { groups: [], assignments: {}, comments: { gone: "keep me" } };
    pruneStale(data, new Set(), Date.now());
    assert.equal(data.comments.gone, "keep me");
  });
});
