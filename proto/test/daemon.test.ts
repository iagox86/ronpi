import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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

  it("hands queued messages back on clear_queue so an abort does not deliver them", async () => {
    harness = await startDaemon({ FAKE_PI_SLOW: "1", FAKE_PI_STEP_MS: "150" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "running" });
    await c.request({ type: "prompt", session: sessionId, message: "queued message" });
    await c.waitFor((m) => m.type === "event" && m.event?.type === "queue_update" && m.event.steering.length === 1);

    const q = await c.request({ type: "clear_queue", session: sessionId });
    assert.deepEqual(q.steering, ["queued message"]);
    await c.request({ type: "abort", session: sessionId });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
    assert.equal(fs.readFileSync(file, "utf8").includes("queued message"), false);
  });

  it("serves pi's slash commands, and the last list once the child is gone", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const live = await c.request({ type: "commands", session: sessionId });
    assert.deepEqual(live.map((x: { name: string }) => x.name), ["skill:demo", "compact"]);
    await c.request({ type: "deactivate", session: sessionId });
    const cached = await c.request({ type: "commands", session: sessionId });
    assert.equal(cached.length, 2);
  });

  it("lists models, switches to a unique match, and refuses an ambiguous or unknown one", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const info = await c.request({ type: "model", session: sessionId });
    assert.equal(info.current, "fake/fake-model");
    assert.deepEqual(info.models, ["fake/fake-model", "fake/fake-big", "other/fake-big"]);
    await assert.rejects(c.request({ type: "model", session: sessionId, query: "fake-big" }), /matches 2 models/);
    await assert.rejects(c.request({ type: "model", session: sessionId, query: "nope" }), /no model matches/);
    const done = await c.request({ type: "model", session: sessionId, query: "other" });
    assert.equal(done.model, "other/fake-big");
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.model, "other/fake-big");
  });

  it("compacts an idle session and reports the sizes", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const r = await c.request({ type: "compact", session: sessionId });
    assert.deepEqual(r, { tokensBefore: 5000, tokensAfter: 800 });
  });

  it("holds messages sent during a compaction and delivers them in order afterwards", async () => {
    harness = await startDaemon({ FAKE_PI_COMPACT_MS: "600" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const compact = c.request({ type: "compact", session: sessionId });
    await new Promise((r) => setTimeout(r, 150));
    const first = await c.request({ type: "prompt", session: sessionId, message: "one" });
    assert.equal(first.disposition, "queued");
    await c.request({ type: "prompt", session: sessionId, message: "two" });
    const queued = c.messages.filter((m) => m.type === "event" && m.event?.type === "queue_update");
    assert.deepEqual(queued.at(-1)?.event.steering, ["one", "two"]);
    await compact;
    await c.waitFor((m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.content?.[0]?.text === "echo: two");
    const replies = c.messages
      .filter((m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.role === "assistant")
      .map((m) => m.event.message.content[0].text);
    assert.deepEqual(replies, ["echo: one", "echo: two"]);
  });

  it("refuses to reload, clear or compact again while a compaction is running", async () => {
    harness = await startDaemon({ FAKE_PI_COMPACT_MS: "600" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const compact = c.request({ type: "compact", session: sessionId });
    await new Promise((r) => setTimeout(r, 150));
    for (const type of ["reload", "clear", "compact"] as const) {
      await assert.rejects(c.request({ type, session: sessionId }), /compacting/);
    }
    await compact;
    await c.request({ type: "reload", session: sessionId });
  });

  it("reloads a session onto a fresh child with the same file and history", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "before" });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile;
    const seen = c.messages.length;
    await c.request({ type: "reload", session: sessionId });
    const history = await c.waitFor((m) => m.type === "history" && c.messages.indexOf(m) >= seen);
    assert.equal(history.messages[0].content, "before");
    const meta = c.sessions().find((s) => s.id === sessionId);
    assert.equal(meta?.sessionFile, file);
    assert.equal(meta?.active, true);
  });

  it("resumes a stopped session from its file and answers only once the child can take commands", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "first" });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
    await c.request({ type: "deactivate", session: sessionId });
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.active, false);
    const r = await c.request({ type: "spawn", sessionFile: file, cwd: harness.dir, ready: true });
    assert.equal(c.sessions().find((s) => s.id === r.sessionId)?.active, true);
    const info = await c.request({ type: "model", session: r.sessionId });
    assert.equal(info.current, "fake/fake-model");
  });

  it("keeps a usage report from a child and shows it on every session of that provider", async () => {
    const report = { v: 1, provider: "fake", source: "zai", windows: [{ label: "5h", pct: 16 }], at: Date.now() };
    harness = await startDaemon({ FAKE_PI_USAGE: JSON.stringify(report) });
    const c = await harness.connect();
    const first = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.id === first.sessionId && s.usage?.windows?.[0]?.pct === 16));
    const second = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.id === second.sessionId && s.usage?.source === "zai"));
    // the record is the daemon's: controllers never see it as a UI request
    assert.ok(!c.messages.some((m: Msg) => m.type === "ui_request" && m.request?.statusKey === "ronpi-usage"));
  });

  it("names a new session when spawned with a name", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir, name: "my new session" });
    await c.waitFor((m) => m.type === "history");
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.sessionName, "my new session");
  });

  it("clears a session in place: same file and session, empty history", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "old context" });
    await c.waitFor(isSettled);
    const before = c.sessions().find((s) => s.id === sessionId)?.sessionFile;
    const seen = c.messages.length;
    await c.request({ type: "clear", session: sessionId });
    const history = await c.waitFor((m) => m.type === "history" && c.messages.indexOf(m) >= seen);
    assert.deepEqual(history.messages, []);
    const meta = c.sessions().find((s) => s.id === sessionId);
    assert.equal(meta?.sessionFile, before);
    assert.equal(meta?.messageCount, 0);
    assert.equal(meta?.active, true);
  });

  it("restores a cleared session's conversation and keeps the model in use", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "precious context" });
    await c.waitFor(isSettled);
    await c.request({ type: "clear", session: sessionId });
    await c.request({ type: "model", session: sessionId, query: "other/fake-big" });
    const seen = c.messages.length;
    const r = await c.request({ type: "restore_clear", session: sessionId });
    assert.ok(r.entries > 0);
    const history = await c.waitFor((m) => m.type === "history" && c.messages.indexOf(m) >= seen);
    assert.equal(history.messages[0].content, "precious context");
    assert.equal((await c.request({ type: "model", session: sessionId })).current, "other/fake-big");
    await assert.rejects(c.request({ type: "restore_clear", session: sessionId }), /nothing to restore/);
  });

  it("forks a live session into a new one and leaves the original running", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "base" });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
    const forked = await c.request({ type: "adopt", path: file, cwd: harness.dir, fork: true });
    assert.notEqual(forked.sessionId, sessionId);
    const all = c.sessions();
    assert.equal(all.find((s) => s.id === sessionId)?.active, true);
    assert.equal(all.find((s) => s.id === forked.sessionId)?.active, true);
  });

  it("names a fork and tells it about its parent, leaving the parent alone", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "base" });
    await c.waitFor(isSettled);
    const parent = c.sessions().find((s) => s.id === sessionId);
    const file = parent?.sessionFile as string;
    const forked = await c.request({
      type: "adopt",
      path: file,
      cwd: harness.dir,
      fork: true,
      name: "FORK Parent",
      parentName: "Parent",
    });
    const fork = c.sessions().find((s) => s.id === forked.sessionId);
    assert.equal(fork?.sessionName, "FORK Parent");
    const notes = (f: string | undefined): string =>
      (JSON.parse(fs.readFileSync(`${f}.argv.json`, "utf8")) as string[]).join("\n");
    assert.match(notes(fork?.sessionFile), /fork of the session "Parent" \(session id [^,]+, file /);
    // the parent is left alone: same child, no restart, no note about the fork
    const after = c.sessions().find((s) => s.id === sessionId);
    assert.equal(after?.sessionFile, file);
    assert.equal(after?.active, true);
    assert.doesNotMatch(notes(file), /has been forked|--append-system-prompt/);
  });

  it("uses the settings' model for a new session but lets a resumed one keep its own", async () => {
    const settings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-settings-")), "settings.json");
    fs.writeFileSync(settings, '{"model":"default-model"}');
    harness = await startDaemon({ RONPI_SETTINGS: settings });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const argv = (): string[] => {
      const f = c.sessions().find((s) => s.id === sessionId)?.sessionFile;
      return JSON.parse(fs.readFileSync(`${f}.argv.json`, "utf8")) as string[];
    };
    assert.ok(argv().includes("default-model"), "a new session starts on the default model");
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    await c.waitFor(isSettled);
    await c.request({ type: "reload", session: sessionId });
    assert.ok(!argv().includes("--model"), "a restart on an existing file does not reset its model");
    await c.request({ type: "model", session: sessionId, query: "other/fake-big" });
    await c.request({ type: "clear", session: sessionId });
    assert.ok(!argv().includes("--model"), "/clear does not pass the default model");
    const after = await c.request({ type: "model", session: sessionId });
    assert.equal(after.current, "other/fake-big", "/clear keeps the model the session was on");
  });

  it("records the settings file's mtime per child and re-reads it on respawn", async () => {
    const settings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-settings-")), "settings.json");
    fs.writeFileSync(settings, '{"model":"a"}');
    fs.utimesSync(settings, new Date(1_000_000), new Date(1_000_000));
    harness = await startDaemon({ RONPI_SETTINGS: settings });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const mtimeOf = () => c.sessions().find((s) => s.id === sessionId)?.settingsMtime;
    assert.equal(mtimeOf(), 1_000_000);

    fs.utimesSync(settings, new Date(2_000_000), new Date(2_000_000));
    assert.equal(mtimeOf(), 1_000_000, "a running child keeps the values it started with");
    await c.request({ type: "deactivate", session: sessionId });
    await c.request({ type: "prompt", session: sessionId, message: "wake up" });
    await c.waitFor(isSettled);
    assert.equal(mtimeOf(), 2_000_000, "the respawned child read the edited file");
    fs.rmSync(path.dirname(settings), { recursive: true, force: true });
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
