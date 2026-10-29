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
    echoPrompt: () => {},
    dropEcho: () => {},
    metaForPath: () => undefined,
    request: (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      return Promise.resolve(responses.shift());
    },
  };
  return { host: host as unknown as Host, requests, notices, history, editorText: () => editorText };
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

    // second enter: confirmed - and it must not fire a follow-up duplicate
    await sa.prompt("hello there");
    assert.equal(fh.requests.length, 2, "second enter must not produce a third request");
    assert.equal(fh.requests[1].confirmFork, true);
    assert.equal(sa.armedFork, null);
    assert.deepEqual(fh.history, ["hello there"]);
  });
});
