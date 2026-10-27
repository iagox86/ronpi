import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Presence } from "../src/presence.ts";

let clock = 0;
let alive = new Set<number>();
let files = new Set<string>();

function presence(): Presence {
  return new Presence({
    now: () => clock,
    pidAlive: (pid) => alive.has(pid),
    exists: (f) => files.has(f),
  });
}

beforeEach(() => {
  clock = 1000;
  alive = new Set([100]);
  files = new Set(["/a"]);
});

describe("Presence", () => {
  it("knows a file is live between register and deregister", () => {
    const p = presence();
    p.register("/a", { pid: 100 });
    assert.equal(p.has("/a"), true);
    assert.equal(p.deregister("/a"), true);
    assert.equal(p.has("/a"), false);
  });

  it("drops a registration whose process exited without deregistering", () => {
    const p = presence();
    p.register("/a", { pid: 100 });
    alive.delete(100);
    assert.deepEqual(p.prune(), [{ file: "/a", reason: "exited" }]);
    assert.equal(p.has("/a"), false);
  });

  it("drops a registration that stopped heartbeating for over 90s", () => {
    const p = presence();
    p.register("/a", { pid: 100 });
    clock += 89_000;
    assert.deepEqual(p.prune(), []);
    clock += 2_000;
    assert.deepEqual(p.prune(), [{ file: "/a", reason: "expired" }]);
  });

  it("keeps a registration alive across heartbeats", () => {
    const p = presence();
    p.register("/a", { pid: 100 });
    clock += 80_000;
    p.register("/a", { pid: 100 });
    clock += 80_000;
    assert.deepEqual(p.prune(), []);
  });

  it("drops a session whose file was seen and then deleted", () => {
    const p = presence();
    p.register("/a", { pid: 100 });
    files.delete("/a");
    assert.deepEqual(p.prune(), [{ file: "/a", reason: "deleted" }]);
  });

  it("keeps a session whose file has not been written yet", () => {
    const p = presence();
    p.register("/unwritten", { pid: 100 });
    assert.deepEqual(p.prune(), []);
    files.add("/unwritten");
    assert.deepEqual(p.prune(), []);
    files.delete("/unwritten");
    assert.deepEqual(p.prune(), [{ file: "/unwritten", reason: "deleted" }]);
  });

  it("keeps the last known cwd when a heartbeat omits it", () => {
    const p = presence();
    p.register("/a", { pid: 100, cwd: "/work" });
    p.register("/a", { pid: 100 });
    assert.equal(p.pseudoMetas(new Set())[0].cwd, "/work");
  });
});

describe("Presence.pseudoMetas", () => {
  it("reports untracked live files tagged, with unaddressable negative ids", () => {
    const p = presence();
    p.register("/a", { pid: 100, cwd: "/work" });
    p.register("/b", { pid: 100 });
    const metas = p.pseudoMetas(new Set());
    assert.deepEqual(metas.map((m) => m.id), [-1, -2]);
    assert.ok(metas.every((m) => m.externallyLive && !m.active));
    assert.equal(metas[1].cwd, "/");
  });

  it("skips files the daemon already tracks itself", () => {
    const p = presence();
    p.register("/a", { pid: 100 });
    assert.deepEqual(p.pseudoMetas(new Set(["/a"])), []);
  });
});
