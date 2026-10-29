// Regression test for #58: the fork-confirm flow must send exactly one daemon
// request per enter. It once sent a third, duplicate prompt (the leftover
// unconditional request after the confirmed one), delivering the message twice.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { SessionActions } from "../src/session-actions.ts";

const KEY = "/tmp/fake/session.jsonl";

function fakeHost(responses: unknown[]) {
  const requests: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const history: string[] = [];
  const sequence: string[] = [];
  let editorText = "";
  const host = {
    viewing: KEY,
    editor: {
      getText: () => editorText,
      setText: (t: string) => {
        editorText = t;
      },
      addToHistory: (t: string) => {
        history.push(t);
      },
    },
    local: new Map([[KEY, { cwd: "/tmp/fake" }]]),
    attachments: {
      take: (text: string) => ({ text, images: [] as string[] }),
      put: (image: string) => image,
    },
    notify: (message: string) => {
      notices.push(message);
    },
    echoPrompt: () => {
      sequence.push("echo");
    },
    dropEcho: () => {
      sequence.push("drop");
    },
    metaForPath: () => undefined,
    request: (cmd: Record<string, unknown>) => {
      sequence.push("request");
      requests.push(cmd);
      return Promise.resolve(responses.shift());
    },
  };
  return { host: host as unknown as Host, requests, notices, history, sequence, editorText: () => editorText };
}

describe("prompt fork-confirm flow", () => {
  it("sends exactly one daemon request per enter", async () => {
    const fh = fakeHost([{ confirmFork: true, ageMs: 5000 }, {}]);
    const sa = new SessionActions(fh.host);

    // first enter: refused by the daemon (fork risk), request armed, text kept
    await sa.prompt("hello there");
    assert.equal(fh.requests.length, 1);
    assert.equal(fh.requests[0].confirmFork, false);
    assert.equal(sa.armedFork, KEY);
    assert.equal(fh.editorText(), "hello there");
    assert.match(fh.notices[0], /enter again to continue here/);
    // the echo precedes the request and is retracted on the refusal -
    // a late echo races pi's own user message and renders the text twice
    assert.deepEqual(fh.sequence.slice(0, 3), ["echo", "request", "drop"]);

    // second enter: confirmed - and it must not fire a follow-up duplicate
    await sa.prompt("hello there");
    assert.equal(fh.requests.length, 2, "second enter must not produce a third request");
    assert.equal(fh.requests[1].confirmFork, true);
    assert.equal(sa.armedFork, null);
    assert.deepEqual(fh.history, ["hello there"]);
    // echo again before the request; no retraction (the delivery happened)
    assert.deepEqual(fh.sequence.slice(3), ["echo", "request"]);
  });

  it("sends once and keeps the echo when enter is pressed again while the session is still starting", async () => {
    const fh = fakeHost([{}]);
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const baseRequest = (fh.host as unknown as { request: (c: Record<string, unknown>) => Promise<unknown> }).request;
    (fh.host as unknown as { request: unknown }).request = (cmd: Record<string, unknown>) => {
      void baseRequest(cmd);
      return slow;
    };
    const sa = new SessionActions(fh.host);

    const first = sa.prompt("hello there");
    // same text again, then different text typed meanwhile, while the first request is unanswered
    assert.equal(await sa.prompt("hello there"), false);
    assert.equal(await sa.prompt("something else"), false);
    assert.equal(fh.requests.length, 1, "only the first enter reaches the daemon");
    assert.ok(!fh.sequence.includes("drop"), "the first send's echo is not retracted");
    assert.equal(fh.editorText(), "something else", "text typed meanwhile is kept, not sent");

    release({});
    assert.equal(await first, true);
    // once answered, the next prompt goes through
    assert.equal(await sa.prompt("next"), true);
    assert.equal(fh.requests.length, 2);
  });
});
