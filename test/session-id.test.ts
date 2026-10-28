import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUuid, resolveSession, uniqueName } from "../src/session-id.ts";

const A = "0b1c2d3e-aaaa-4bbb-8ccc-111111111111";
const B = "0b1c2d3e-bbbb-4bbb-8ccc-222222222222";
const C = "ffffffff-cccc-4bbb-8ccc-333333333333";
const sessions = [
  { id: 1, sessionId: A, sessionName: "Alpha" },
  { id: 2, sessionId: B, sessionName: "Beta" },
  { id: 3, sessionId: C, sessionName: "alpha" },
  { id: 4 },
];

describe("resolveSession", () => {
  it("finds a session by full UUID, regardless of case", () => {
    assert.deepEqual(resolveSession(C.toUpperCase(), sessions), { kind: "found", session: sessions[2] });
  });

  it("finds a session by a unique UUID prefix of at least 8 characters, and says when it is shared", () => {
    assert.deepEqual(resolveSession("ffffffff", sessions), { kind: "found", session: sessions[2] });
    assert.equal(resolveSession("0b1c2d3e", sessions).kind, "ambiguous");
    assert.equal(resolveSession("0b1c2d3e-a", sessions).kind, "found");
    assert.equal(resolveSession("0b1c2d", sessions).kind, "none"); // too short to be a prefix
  });

  it("finds a session by #number", () => {
    assert.deepEqual(resolveSession("#2", sessions), { kind: "found", session: sessions[1] });
    assert.equal(resolveSession("#9", sessions).kind, "none");
  });

  it("finds a session by name, ignoring case, and calls duplicate names ambiguous", () => {
    assert.deepEqual(resolveSession("beta", sessions), { kind: "found", session: sessions[1] });
    const r = resolveSession("ALPHA", sessions);
    assert.equal(r.kind, "ambiguous");
    assert.equal(r.kind === "ambiguous" && r.matches.length, 2);
  });

  it("prefers a UUID match over a name that happens to look alike", () => {
    const tricky = [{ id: 1, sessionId: A }, { id: 2, sessionName: A }];
    assert.deepEqual(resolveSession(A, tricky), { kind: "found", session: tricky[0] });
  });
});

describe("uniqueName", () => {
  it("keeps a free name and suffixes a taken one, ignoring case", () => {
    assert.equal(uniqueName("Plan", ["Other"]), "Plan");
    assert.equal(uniqueName("Plan", ["plan"]), "Plan #2");
    assert.equal(uniqueName("Plan", ["Plan", "Plan #2"]), "Plan #3");
  });

  it("does not stack suffixes", () => {
    assert.equal(uniqueName("Plan #2", ["Plan #2", "Plan"]), "Plan #3");
  });
});

describe("isUuid", () => {
  it("accepts a UUID and nothing else", () => {
    assert.ok(isUuid(A));
    assert.ok(!isUuid("0b1c2d3e"));
    assert.ok(!isUuid(`${A}x`));
  });
});
