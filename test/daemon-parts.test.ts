import assert from "node:assert/strict";
import type * as net from "node:net";
import { describe, it } from "node:test";
import { ClientHub } from "../src/daemon-hub.ts";
import { sessionMetas } from "../src/daemon-meta.ts";
import { requireIdle, SessionRegistry } from "../src/daemon-session.ts";
import { Presence } from "../src/presence.ts";

function fakeSocket() {
  const written: string[] = [];
  const socket = { destroyed: false, write: (s: string) => written.push(s) } as unknown as net.Socket;
  return { socket, written, messages: () => written.map((l) => JSON.parse(l) as { type: string; [k: string]: unknown }) };
}

describe("SessionRegistry", () => {
  it("hands out increasing ids and finds sessions by id or by file", () => {
    const reg = new SessionRegistry();
    const a = reg.create("/w", "/a.jsonl");
    const b = reg.create("/w");
    assert.equal(b.id, a.id + 1);
    assert.equal(reg.get(a.id), a);
    assert.equal(reg.byFile("/a.jsonl"), a);
    assert.equal(reg.find({ session: b.id }), b);
    assert.equal(reg.find({ path: "/a.jsonl" }), a);
    assert.equal(reg.find({}), undefined);
  });

  it("says a session is not active unless it has a child", () => {
    const reg = new SessionRegistry();
    const s = reg.create("/w");
    assert.throws(() => reg.live(s.id), /not active/);
    s.child = {} as never;
    assert.equal(reg.live(s.id), s);
  });

  it("lets callers delete sessions while looping over a snapshot", () => {
    const reg = new SessionRegistry();
    reg.create("/w");
    reg.create("/w");
    for (const s of reg.all()) {
      reg.delete(s.id);
    }
    assert.equal(reg.all().length, 0);
  });
});

describe("requireIdle", () => {
  it("refuses a session that is working or compacting, and allows an idle one", () => {
    const s = new SessionRegistry().create("/w");
    requireIdle(s);
    s.streaming = true;
    assert.throws(() => requireIdle(s), /working/);
    s.streaming = false;
    s.held = [];
    assert.throws(() => requireIdle(s), /compacting/);
  });
});

describe("ClientHub", () => {
  const hub = () => new ClientHub((socket) => [{ id: 1, cwd: "/w", sessionName: socket === a.socket ? "for-a" : "for-b" } as never]);
  const a = fakeSocket();
  const b = fakeSocket();

  it("sends each controller its own view of the session list", () => {
    const h = hub();
    h.addController(a.socket);
    h.addController(b.socket);
    h.broadcastSessions();
    const nameSeenBy = (s: ReturnType<typeof fakeSocket>) => {
      const sessions = (s.messages().at(-1) ?? { sessions: [] }).sessions as Array<{ sessionName: string }>;
      return sessions[0]?.sessionName;
    };
    assert.equal(nameSeenBy(a), "for-a");
    assert.equal(nameSeenBy(b), "for-b");
  });

  it("keeps presence-only sockets out of broadcasts and says what kind of socket closed", () => {
    const h = hub();
    const presence = fakeSocket();
    h.addController(a.socket);
    h.addPresenceOnly(presence.socket);
    h.broadcast({ type: "exited", session: 1 } as never);
    assert.equal(presence.written.length, 0);
    assert.equal(h.remove(presence.socket), "presence");
    assert.equal(h.remove(a.socket), "controller");
    assert.equal(h.remove(a.socket), "unknown");
  });

  it("announces held messages in the shape of pi's queue update", () => {
    const h = hub();
    const c = fakeSocket();
    h.addController(c.socket);
    h.announceQueue(7, ["one", "two"]);
    const msg = c.messages().at(-1) as unknown as { session: number; event: { type: string; steering: string[] } };
    assert.equal(msg.session, 7);
    assert.deepEqual(msg.event, { type: "queue_update", steering: ["one", "two"], followUp: [] });
  });

  it("does not write to a destroyed socket", () => {
    const h = hub();
    const c = fakeSocket();
    (c.socket as { destroyed: boolean }).destroyed = true;
    h.send(c.socket, { type: "exited", session: 1 } as never);
    assert.equal(c.written.length, 0);
  });
});

describe("sessionMetas", () => {
  it("marks which session the asking socket is attached to", () => {
    const reg = new SessionRegistry();
    const s = reg.create("/w");
    const mine = fakeSocket().socket;
    s.attachedTo = mine;
    const asMine = sessionMetas(reg, new Presence(), new Map(), mine)[0];
    const asOther = sessionMetas(reg, new Presence(), new Map(), fakeSocket().socket)[0];
    assert.equal(asMine?.attachedToYou, true);
    assert.equal(asOther?.attachedElsewhere, true);
  });

  it("shows the newest usage report of the session's provider", () => {
    const reg = new SessionRegistry();
    reg.create("/w").provider = "zai";
    const report = { v: 1, provider: "zai", source: "zai", windows: [], at: 1 } as never;
    const [meta] = sessionMetas(reg, new Presence(), new Map([["zai", report]]), fakeSocket().socket);
    assert.equal(meta?.usage, report);
  });
});
