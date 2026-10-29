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

  it("re-syncs a stale queue strip once pi reports nothing pending (#47)", async () => {
    // queue_update is fire-and-forget, so a lost removal event would leave a
    // controller showing "queued" lines forever. With the drop flag fake-pi
    // delivers the message but withholds the empty-queue update; the daemon must
    // reconcile against pi at settle and announce the cleared queue itself.
    harness = await startDaemon({ FAKE_PI_SLOW: "1", FAKE_PI_STEP_MS: "150", FAKE_PI_DROP_QUEUE_REMOVAL: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "running" });
    await c.request({ type: "prompt", session: sessionId, message: "queued message" });
    await c.waitFor((m) => m.type === "event" && m.event?.type === "queue_update" && m.event.steering.length === 1);
    await c.waitFor(isSettled);

    // the reconcile runs just behind agent_settled (async refreshMeta); earlier empty
    // updates from spawn-time refreshMeta don't count
    await c.waitFor(() => {
      const settled = c.messages.findIndex(isSettled);
      return c.messages.some(
        (m, i) =>
          i > settled &&
          m.type === "event" &&
          m.event?.type === "queue_update" &&
          m.session === sessionId &&
          m.event.steering.length === 0,
      );
    }, 5000);
  });

  it("delivers messages from other sessions through the session bridge, as custom entries with a self-clearing strip", async () => {
    // A child that offers /ronpi-inject gets the message as that command, never through pi's
    // steering queue. Mid-run it lands as an appended custom entry at the turn boundary, and
    // the strip shows it pending until the daemon sees that append.
    harness = await startDaemon({ FAKE_PI_SLOW: "1", FAKE_PI_STEP_MS: "150", FAKE_PI_BRIDGE: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "running" });
    const r = await c.request({ type: "message", to: `#${sessionId}`, text: "bridged hello" });
    assert.equal((r as { via?: string }).via, "bridge");

    const pendingAt = c.messages.findIndex(
      (m) => m.type === "event" && m.event?.type === "queue_update" && m.session === sessionId && m.event.steering.length === 1,
    );
    assert.ok(pendingAt !== -1, "the strip never showed the message pending");
    await c.waitFor(() =>
      c.messages.some(
        (m, i) => i > pendingAt && m.type === "event" && m.event?.type === "queue_update" && m.session === sessionId && m.event.steering.length === 0,
      ),
    );
    assert.ok(c.messages.some((m) => m.type === "event" && m.event?.type === "entry_appended"), "controllers must see the appended entry to draw it");

    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
    const entries = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l)
      .map((l) => JSON.parse(l) as { type?: string; customType?: string; content?: unknown; message?: { role?: string; content?: unknown } });
    const injected = entries.find((e) => e.type === "custom_message" && e.customType === "ronpi-inject");
    assert.ok(injected, "no custom_message entry for the bridged message");
    assert.ok(JSON.stringify(injected.content).includes("bridged hello"));
    const asUserPrompt = entries.some((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes("bridged hello"));
    assert.equal(asUserPrompt, false);
  });

  it("says so when a session stops before a bridged message reached its transcript", async () => {
    harness = await startDaemon({ FAKE_PI_SLOW: "1", FAKE_PI_STEP_MS: "300", FAKE_PI_BRIDGE: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "running" });
    await c.request({ type: "message", to: `#${sessionId}`, text: "will be lost" });
    await c.request({ type: "deactivate", session: sessionId });
    const gone = await c.waitFor((m) => m.type === "exited" && m.session === sessionId);
    assert.match(String(gone.reason), /1 message from other sessions did not arrive.*will be lost/);
  });

  it("starts an idle session's turn with a bridged message, and confirms it", async () => {
    harness = await startDaemon({ FAKE_PI_BRIDGE: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const r = await c.request({ type: "message", to: `#${sessionId}`, text: "wake up via bridge" });
    assert.equal((r as { via?: string }).via, "bridge");
    await c.waitFor((m) => m.type === "event" && m.session === sessionId && m.event?.type === "message_end" && m.event.message?.customType === "ronpi-inject");
    await c.waitFor(isSettled);
    const meta = c.sessions().find((s) => s.id === sessionId);
    assert.equal(meta?.sessionBridge, true);
  });

  it("falls back to steering, with the session marked as lacking the bridge, when the child does not offer it", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const r = await c.request({ type: "message", to: `#${sessionId}`, text: "plain hello" });
    assert.equal((r as { via?: string }).via, "legacy");
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.sessionBridge, false);
  });

  it("hands a message to pi's steering queue when the bridge reports it could not deliver", async () => {
    harness = await startDaemon({ FAKE_PI_BRIDGE: "1", FAKE_PI_BRIDGE_FAIL: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "message", to: `#${sessionId}`, text: "rescued" });
    await c.waitFor((m) => m.type === "event" && m.session === sessionId && m.event?.type === "message_start" && JSON.stringify(m.event.message).includes("rescued"));
  });

  it("confirms before touching a brand-new recently-modified session file, then proceeds once confirmed", async () => {
    // A file this daemon has never handled may belong to a presence-less
    // external pi (undetectable); a fresh mtime is the signal, and the
    // daemon must not touch the file until the user confirms. Files it has
    // handled before are its own and never confirm, whatever their mtime.
    harness = await startDaemon();
    const c = await harness.connect();
    const file = path.join(harness.dir, "fresh-session.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "fresh" })}\n`);
    const r = await c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "hello" });
    assert.equal((r as { confirmFork?: boolean }).confirmFork, true);
    assert.ok(c.sessions().every((s) => s.sessionFile !== file));

    const r2 = await c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "hello", confirmFork: true });
    await c.waitFor((m) => m.type === "history");
    const s = c.sessions().find((x) => x.sessionFile === file);
    assert.ok(s, "confirmed prompt should register and start the session");
    // exactly one delivery: the confirmed prompt, nothing else. The fake-pi
    // writes the session file only after it processes the prompt, which can
    // lag the daemon's history replay, so poll rather than trusting history.
    let userEntries = 0;
    for (let i = 0; i < 50; i++) {
      const entries = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      userEntries = entries.filter((e) => e.message?.role === "user").length;
      if (userEntries > 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(userEntries, 1, "one user entry after one confirmed prompt");

    // now the daemon owns it: recent mtime or not, no confirm
    fs.appendFileSync(file, "\n");
    const r3 = await c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "again" });
    assert.equal((r3 as { confirmFork?: boolean }).confirmFork, undefined);
  });

  it("does not ask about a fresh session file that ronpi ran before a daemon restart", async () => {
    const handled = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-handled-")), "handled.json");
    harness = await startDaemon({ RONPI_HANDLED: handled });
    const c = await harness.connect();
    const file = path.join(harness.dir, "was-ours.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "ours" })}\n`);
    fs.writeFileSync(handled, JSON.stringify([file]));
    const r = await c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "hello" });
    assert.equal((r as { confirmFork?: boolean }).confirmFork, undefined, "a file ronpi ran before is its own");
    await c.waitFor((m) => m.type === "history");
    assert.ok(JSON.parse(fs.readFileSync(handled, "utf8")).includes(file));
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

  it("returns pi's /mcp status text without showing it to controllers or adding it to the conversation", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const seen = c.messages.length;
    const r = await c.request({ type: "mcp_status", session: sessionId });
    assert.match(r.text, /^mealie: connected, 12 tools/);
    assert.match(r.text, /config error: bad\.json/);
    const after = c.messages.slice(seen);
    assert.ok(!after.some((m) => m.type === "ui_request"), "the notice must not reach controllers");
    assert.ok(!after.some((m) => m.type === "event" && m.event?.type === "message_start"), "no message enters the conversation");
  });

  it("sends the waiting dialog again when asked, and forgets it once pi has timed it out", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "/ask" });
    await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-1");
    const pending = (m: Msg) => m.type === "sessions" && m.sessions?.some((x: { id: number; pendingDialog: boolean }) => x.id === sessionId && x.pendingDialog);
    await c.waitFor(pending);
    const seen = c.messages.filter((m: Msg) => m.type === "ui_request").length;
    await c.request({ type: "attach", session: sessionId });
    await c.waitFor(() => c.messages.filter((m: Msg) => m.type === "ui_request").length > seen);
    const cleared = (m: Msg) => m.type === "sessions" && m.sessions?.some((x: { id: number; pendingDialog: boolean }) => x.id === sessionId && !x.pendingDialog);
    const mark = c.messages.length;
    await c.waitFor((m) => cleared(m) && c.messages.indexOf(m) >= mark);
  });

  it("runs a !command, tells the agent the result at once, and can stop a long one", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const done = await c.request({ type: "bash", session: sessionId, command: "echo hi; echo oops >&2; exit 3" });
    assert.deepEqual([done.output, done.exitCode, done.cancelled], ["hi\noops\n", 3, false]);
    const told = await c.waitFor((m) => m.type === "event" && m.event?.type === "message_start" && JSON.stringify(m.event).includes("<local-command>"));
    const text = JSON.stringify(told.event);
    assert.match(text, /<local-command>echo hi; echo oops >&2; exit 3<\/local-command>/);
    assert.match(text, /exit=\\"3\\"/);
    assert.match(text, /you did not run it|You did not run it/i);

    const long = c.request({ type: "bash", session: sessionId, command: "sleep 30" });
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(c.request({ type: "bash", session: sessionId, command: "echo again" }), /already running/);
    await c.request({ type: "abort_bash", session: sessionId });
    const stopped = await long;
    assert.equal(stopped.cancelled, true);
  });

  it("names a session whose first message is a !command, after the command", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "bash", session: sessionId, command: "echo hi; echo oops >&2; exit 3" });
    await c.waitFor(
      (m) =>
        m.type === "sessions" &&
        (m.sessions as Msg[]).some((s) => s.id === sessionId && s.sessionName === "echo hi; echo oops >&2; exit 3"),
    );
    // not pi's auto-name after the wrapper around the bash input
    const name = c.sessions().find((s) => s.id === sessionId)?.sessionName as string;
    assert.ok(!name.startsWith("<local-command-caveat"), `name leaked the wrapper: ${name}`);
    assert.equal(name, "echo hi; echo oops >&2; exit 3");
    // a later !command does not rename the session again
    await c.request({ type: "bash", session: sessionId, command: "echo again" });
    const named = c.sessions().find((s) => s.id === sessionId);
    assert.equal(named?.sessionName, "echo hi; echo oops >&2; exit 3");
    // a plain prompt still leaves the session unnamed, for the first-message fallback
    const { sessionId: plain } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history" && m.session === plain);
    await c.request({ type: "prompt", session: plain, message: "hello" });
    assert.equal(c.sessions().find((s) => s.id === plain)?.sessionName, undefined);
  });

  it("passes pasted images on with the prompt", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    await c.request({ type: "prompt", session: sessionId, message: "look", images: [image] });
    const reply = await c.waitFor(
      (m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.role === "assistant",
    );
    assert.equal(reply.event.message.content[0].text, "echo: look [1 image(s): image/png]");
  });

  it("keeps the images of a message held during a compaction", async () => {
    harness = await startDaemon({ FAKE_PI_COMPACT_MS: "500" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const compact = c.request({ type: "compact", session: sessionId });
    await new Promise((r) => setTimeout(r, 120));
    const held = await c.request({
      type: "prompt",
      session: sessionId,
      message: "later",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" }],
    });
    assert.equal(held.disposition, "queued");
    await compact;
    const reply = await c.waitFor(
      (m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.content?.[0]?.text?.startsWith("echo: later"),
    );
    assert.match(reply.event.message.content[0].text, /\[1 image\(s\): image\/jpeg\]/);
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

  it("starts a session as an agent profile and keeps its loadout across a respawn", async () => {
    harness = await startDaemon({ RONPI_AGENTS_DIR: path.join(os.tmpdir(), "ronpi-no-user-agents") });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir, agent: "explore" });
    await c.waitFor((m) => m.type === "history");
    const file = (): string | undefined => c.sessions().find((x) => x.id === sessionId)?.sessionFile;
    const argv = (): string[] => JSON.parse(fs.readFileSync(`${file()}.argv.json`, "utf8")) as string[];
    assert.equal(c.sessions().find((x) => x.id === sessionId)?.agent, "explore");
    assert.deepEqual(argv().slice(argv().indexOf("--tools"), argv().indexOf("--tools") + 3), ["--tools", "read,grep,find,ls", "--no-mcp"]);
    assert.ok(argv().includes("--append-system-prompt"));

    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    await c.waitFor(isSettled);
    await c.request({ type: "deactivate", session: sessionId });
    await c.request({ type: "prompt", session: sessionId, message: "again" });
    await c.waitFor(isSettled);
    assert.ok(argv().includes("--tools"), "the respawn kept the tool limits");
    assert.ok(!argv().includes("--thinking"), "but did not reset the model settings of an existing session");
    assert.equal(c.sessions().find((x) => x.id === sessionId)?.agent, "explore");
  });

  it("adds ronpi's tools to the loadout on every start and resume, unless a profile owns the tool list", async () => {
    harness = await startDaemon({ RONPI_AGENTS_DIR: path.join(os.tmpdir(), "ronpi-no-user-agents") });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const argv = (): string[] => {
      const f = c.sessions().find((x) => x.id === sessionId)?.sessionFile;
      return JSON.parse(fs.readFileSync(`${f}.argv.json`, "utf8")) as string[];
    };
    const tools = (): string | undefined => argv()[argv().indexOf("--tools") + 1];
    assert.equal(tools(), "+ronpi_message,+ronpi_usage");
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    await c.waitFor(isSettled);
    await c.request({ type: "reload", session: sessionId });
    assert.equal(tools(), "+ronpi_message,+ronpi_usage", "a /reload resume passes them again");

    const explore = await c.request({ type: "spawn", cwd: harness.dir, agent: "explore" });
    await c.waitFor((m) => m.type === "history" && m.session === explore.sessionId);
    const f = c.sessions().find((x) => x.id === explore.sessionId)?.sessionFile;
    const eargv = JSON.parse(fs.readFileSync(`${f}.argv.json`, "utf8")) as string[];
    assert.equal(eargv.filter((a) => a === "--tools").length, 1, "a profile's own --tools is not mixed with modifiers");
  });

  it("reports how many messages pi holds when a run settles, and replays history on a resync request", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    await c.waitFor(isSettled);
    const digest = await c.waitFor((m) => m.type === "digest" && m.session === sessionId);
    assert.equal(digest.streaming, false);
    assert.ok((digest.messages as number) >= 2, "the prompt and the reply");
    const history = c.waitFor((m) => m.type === "history" && m.session === sessionId && (m.messages as unknown[]).length === digest.messages);
    await c.request({ type: "resync", session: sessionId });
    await history;
  });

  it("refuses to start an unknown agent and names the ones it has", async () => {
    harness = await startDaemon({ RONPI_AGENTS_DIR: path.join(os.tmpdir(), "ronpi-no-user-agents") });
    const c = await harness.connect();
    await assert.rejects(c.request({ type: "spawn", cwd: harness.dir, agent: "nope" }), /no agent called "nope" \(have: explore, summarize\)/);
  });

  it("gives a new session an id before pi starts and tells the child", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const r = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    assert.match(r.uuid, /^[0-9a-f]{8}-/);
    const file = c.sessions().find((x) => x.id === r.sessionId)?.sessionFile as string;
    const argv = JSON.parse(fs.readFileSync(`${file}.argv.json`, "utf8")) as string[];
    assert.equal(argv[argv.indexOf("--session-id") + 1], r.uuid);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.env.json`, "utf8")).RONPI_SESSION_ID, r.uuid);
    assert.equal(c.sessions().find((x) => x.id === r.sessionId)?.sessionId, r.uuid);
    // a respawn of the same file is the same session, so the child is told the same id
    await c.request({ type: "prompt", session: r.sessionId, message: "hi" });
    await c.waitFor(isSettled);
    await c.request({ type: "deactivate", session: r.sessionId });
    await c.request({ type: "prompt", session: r.sessionId, message: "again" });
    await c.waitFor(isSettled);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.env.json`, "utf8")).RONPI_SESSION_ID, r.uuid);
  });

  it("resolves a session from its UUID, prefix, #number or name, and says when it cannot", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const one = await c.request({ type: "spawn", cwd: harness.dir, name: "Resolver One" });
    const two = await c.request({ type: "spawn", cwd: harness.dir, name: "Resolver Two" });
    await c.waitFor((m) => m.type === "history");
    await c.waitFor(() => c.sessions().filter((x) => x.sessionName).length === 2);
    const by = async (query: string) => c.request({ type: "resolve", query });
    assert.equal((await by(one.uuid)).id, one.sessionId);
    assert.equal((await by(two.uuid.slice(0, 10))).id, two.sessionId);
    assert.equal((await by(`#${two.sessionId}`)).uuid, two.uuid);
    assert.equal((await by("resolver one")).uuid, one.uuid);
    await assert.rejects(by("no such session"), /no session matches/);
  });

  it("delivers a message to another session, labelled with the sender, and wakes an idle one without taking its attach", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const a = await c.request({ type: "spawn", cwd: harness.dir, name: "Sender" });
    const b = await c.request({ type: "spawn", cwd: harness.dir, name: "Receiver" });
    await c.waitFor(() => c.sessions().filter((x) => x.sessionName).length === 2);
    await c.request({ type: "prompt", session: b.sessionId, message: "first" });
    await c.waitFor(isSettled);
    await c.request({ type: "deactivate", session: b.sessionId });
    const file = c.sessions().find((x) => x.id === b.sessionId)?.sessionFile as string;

    const sender = await harness.connect();
    const r = await sender.request({ type: "message", to: "receiver", text: "please check X", from: a.uuid });
    assert.equal(r.delivered, true);
    assert.equal(r.to, "Receiver");
    // wait for the turn the message started (isSettled alone could match the earlier one)
    await c.waitFor((m) => m.type === "event" && m.event?.type === "message_start" && JSON.stringify(m.event).includes("please check X"));
    await c.waitFor((m) => isSettled(m) && c.messages.indexOf(m) > c.messages.findIndex((x) => JSON.stringify(x).includes("please check X")));
    const meta = c.sessions().find((x) => x.id === b.sessionId);
    assert.equal(meta?.active, true, "the idle session was started");
    assert.equal(meta?.attachedToYou, false, "delivering does not take the input attach");
    assert.equal(meta?.attachedElsewhere, false);
    assert.match(fs.readFileSync(file, "utf8"), new RegExp(`\\[from Sender \\(${a.uuid}\\)\\]: please check X`));
  });

  it("says why a message cannot be delivered", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const a = await c.request({ type: "spawn", cwd: harness.dir, name: "Solo" });
    await c.waitFor((m) => m.type === "history");
    await c.waitFor(() => c.sessions().some((x) => x.sessionName === "Solo"));
    await assert.rejects(c.request({ type: "message", to: "nobody", text: "hi" }), /no session matches/);
    await assert.rejects(c.request({ type: "message", to: "Solo", text: "  " }), /empty/);
    await assert.rejects(c.request({ type: "message", to: "Solo", text: "hi", from: a.uuid }), /cannot message itself/);
  });

  it("queues a message behind the work a busy session is doing", async () => {
    harness = await startDaemon({ FAKE_PI_SLOW: "1", FAKE_PI_STEP_MS: "150" });
    const c = await harness.connect();
    const busy = await c.request({ type: "spawn", cwd: harness.dir, name: "Busy" });
    await c.waitFor(() => c.sessions().some((x) => x.sessionName === "Busy"));
    await c.request({ type: "prompt", session: busy.sessionId, message: "work" });
    await c.waitFor(() => c.sessions().find((x) => x.id === busy.sessionId)?.streaming === true);
    const r = await c.request({ type: "message", to: "Busy", text: "psst" });
    assert.match(r.disposition, /queued/);
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
