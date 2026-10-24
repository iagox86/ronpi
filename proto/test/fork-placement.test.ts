import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FORK_MARK, forkName, placeFork } from "../fork-placement.ts";
import type { GroupsFile } from "../groups.ts";

describe("forkName", () => {
  it("prefixes the parent's name with the fork mark", () => {
    assert.equal(forkName("Research"), `${FORK_MARK} Research`);
  });

  it("does not stack marks when forking a fork", () => {
    assert.equal(forkName(`${FORK_MARK} Research`), `${FORK_MARK} Research`);
  });
});

describe("placeFork", () => {
  it("puts the fork right below its parent and copies the parent's group", () => {
    const groups: GroupsFile = { groups: ["work"], assignments: { a: "work" }, order: ["x", "a", "y"] };
    placeFork(groups, "a", "f");
    assert.deepEqual(groups.order, ["x", "a", "f", "y"]);
    assert.equal(groups.assignments.f, "work");
  });

  it("adds an unranked parent to the order first", () => {
    const groups: GroupsFile = { groups: [], assignments: {}, order: ["x"] };
    placeFork(groups, "a", "f");
    assert.deepEqual(groups.order, ["x", "a", "f"]);
    assert.equal("f" in groups.assignments, false);
  });

  it("keeps an explicit ungroup", () => {
    const groups: GroupsFile = { groups: [], assignments: { a: null }, order: ["a"] };
    placeFork(groups, "a", "f");
    assert.equal(groups.assignments.f, null);
  });
});
