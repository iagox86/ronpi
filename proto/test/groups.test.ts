import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { groupsFile, loadGroups, resolveGroup, saveGroups } from "../groups.ts";

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
