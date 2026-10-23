import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Harness, type Msg, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

describe("daemon: sessions", () => {
  it("sends the session list to a newly connected controller", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    await c.request({ type: "list" });
    await c.waitFor((m) => m.type === "sessions");
    assert.deepEqual(c.sessions(), []);
  });

  it("replies to spawn before the child has finished starting", async () => {
    harness = await startDaemon({ FAKE_PI_STARTUP_MS: "1500" });
    const c = await harness.connect();
    const t0 = Date.now();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    assert.ok(Date.now() - t0 < 1000, "spawn reply should not wait for the child");
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.active, false);

    await c.waitFor((m) => m.type === "history" && m.session === sessionId);
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.active, true);
  });

  it("delivers a prompt sent while the child is still starting", async () => {
    harness = await startDaemon({ FAKE_PI_STARTUP_MS: "800" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.request({ type: "prompt", session: sessionId, message: "hello" });
    const reply = await c.waitFor(
      (m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.role === "assistant",
    );
    assert.equal(reply.event.message.content[0].text, "echo: hello");
  });

  it("streams events to every connected controller", async () => {
    harness = await startDaemon();
    const driver = await harness.connect();
    const watcher = await harness.connect();
    await watcher.request({ type: "list" });
    const { sessionId } = await driver.request({ type: "spawn", cwd: harness.dir });
    await driver.waitFor((m) => m.type === "history");
    await driver.request({ type: "prompt", session: sessionId, message: "hi" });
    await watcher.waitFor(isSettled);
    assert.ok(watcher.messages.some((m) => m.type === "event" && m.event?.type === "message_end"));
  });

  it("rolls token and cost usage up per session", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    await c.waitFor(isSettled);
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.id === sessionId && s.tokens > 0));
    const meta = c.sessions().find((s) => s.id === sessionId);
    assert.equal(meta?.tokens, 10);
  });

  it("renames a live session", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "rename", session: sessionId, name: "renamed" });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.id === sessionId && s.sessionName === "renamed"));
  });
});

describe("daemon: input attach", () => {
  it("refuses a second controller until it takes over", async () => {
    harness = await startDaemon();
    const first = await harness.connect();
    const second = await harness.connect();
    const { sessionId } = await first.request({ type: "spawn", cwd: harness.dir });
    await first.waitFor((m) => m.type === "history");
    await second.request({ type: "list" });

    await assert.rejects(second.request({ type: "attach", session: sessionId }), /attached to another controller/);
    await second.request({ type: "attach", session: sessionId, force: true });
    await first.waitFor(
      (m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.id === sessionId && s.attachedElsewhere),
    );
  });
});

describe("daemon: lifecycle", () => {
  it("keeps the session file when deactivated and replays it on the next prompt", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "first" });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile;
    assert.ok(file && fs.existsSync(file));

    await c.request({ type: "deactivate", session: sessionId });
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.active, false);
    assert.ok(fs.existsSync(file));

    const before = c.messages.length;
    await c.request({ type: "prompt", session: sessionId, message: "second" });
    const history = await c.waitFor((m) => m.type === "history" && m.messages.length >= 2);
    assert.equal(history.messages[0].content, "first");
    assert.ok(c.messages.length > before);
  });

  it("moves a deleted session file to the trash with a manifest instead of unlinking it", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "keep me" });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;

    const { trashedTo } = await c.request({ type: "delete", session: sessionId });
    assert.equal(fs.existsSync(file), false);
    assert.ok(fs.readFileSync(trashedTo, "utf8").includes("keep me"));
    const manifest = JSON.parse(fs.readFileSync(`${trashedTo}.json`, "utf8"));
    assert.equal(manifest.originalPath, file);
    assert.equal(c.sessions().some((s) => s.id === sessionId), false);
  });

  it("rewinds to before a user message, trashes the tail, and lets the session carry on", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "one" });
    await c.waitFor(isSettled);
    await c.request({ type: "prompt", session: sessionId, message: "two" });
    await c.waitFor((m) => isSettled(m) && c.messages.filter(isSettled).length >= 2);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
    const entries = () => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const second = entries().find((e) => e.message?.content === "two");

    const r = await c.request({ type: "rewind", session: sessionId, entryId: second.id });
    assert.equal(r.text, "two");
    assert.equal(r.removed, 2);
    assert.equal(entries().some((e) => JSON.stringify(e).includes("two")), false);
    assert.ok(fs.readFileSync(r.trashedTo, "utf8").includes("two"));
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.active, false, "the child is stopped");

    await c.request({ type: "prompt", session: sessionId, message: "three" });
    await c.waitFor((m) => isSettled(m) && c.messages.filter(isSettled).length >= 3);
    assert.ok(entries().some((e) => e.message?.content === "three"));
  });

  it("refuses to rewind a session that is mid-run", async () => {
    harness = await startDaemon({ FAKE_PI_RUN_MS: "1500" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "slow" });
    await assert.rejects(c.request({ type: "rewind", session: sessionId, entryId: "x" }), /working/);
  });

  it("drops a never-prompted session on delete without touching the disk", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "delete", session: sessionId });
    assert.equal(c.sessions().some((s) => s.id === sessionId), false);
    assert.equal(fs.existsSync(path.join(harness.dir, "trash")), false);
  });
});

describe("daemon: sessions open in an external pi", () => {
  const register = (h: Harness, file: string, pid: number, live = true) =>
    h.connect().then((presence) =>
      presence.request({ type: "external_register", pid, sessionFile: file, cwd: h.dir, live }),
    );

  it("reports an externally live session tagged, in the first list a controller receives", async () => {
    harness = await startDaemon();
    const file = path.join(harness.dir, "pi-session.jsonl");
    fs.writeFileSync(file, "{}\n");
    await register(harness, file, process.pid);

    const c = await harness.connect();
    c.send({ type: "list" });
    const first = await c.waitFor((m) => m.type === "sessions");
    const entry = first.sessions.find((s: Msg) => s.sessionFile === file);
    assert.equal(entry?.externallyLive, true);
  });

  it("reports a live session before its file exists so the controller can hide it", async () => {
    harness = await startDaemon();
    const file = path.join(harness.dir, "not-yet-written.jsonl");
    await register(harness, file, process.pid);

    const c = await harness.connect();
    c.send({ type: "list" });
    const first = await c.waitFor((m) => m.type === "sessions");
    assert.equal(first.sessions.find((s: Msg) => s.sessionFile === file)?.externallyLive, true);
  });

  it("removes the tag when the extension deregisters", async () => {
    harness = await startDaemon();
    const file = path.join(harness.dir, "pi-session.jsonl");
    fs.writeFileSync(file, "{}\n");
    await register(harness, file, process.pid);
    const c = await harness.connect();
    c.send({ type: "list" });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.sessionFile === file));

    await register(harness, file, process.pid, false);
    await c.waitFor((m) => m.type === "sessions" && !m.sessions.some((s: Msg) => s.sessionFile === file));
  });

  it("removes the tag when the pi process exits without deregistering", async () => {
    harness = await startDaemon();
    const file = path.join(harness.dir, "pi-session.jsonl");
    fs.writeFileSync(file, "{}\n");
    const pi = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    assert.ok(pi.pid);
    await register(harness, file, pi.pid);
    const c = await harness.connect();
    c.send({ type: "list" });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.sessionFile === file));

    pi.kill("SIGKILL");
    await c.waitFor((m) => m.type === "sessions" && !m.sessions.some((s: Msg) => s.sessionFile === file), 10_000);
  });

  it("refuses to prompt a session that is live in another pi", async () => {
    harness = await startDaemon();
    const file = path.join(harness.dir, "pi-session.jsonl");
    fs.writeFileSync(file, "{}\n");
    await register(harness, file, process.pid);
    const c = await harness.connect();
    await assert.rejects(
      c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "hi" }),
      /live in another pi/,
    );
  });
});
