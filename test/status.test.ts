import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStatusLine, fleetStats, stateLabel } from "../src/status.ts";
import type { SessionMeta } from "../src/shared.ts";

// Styling is ANSI; the assertions are about the text.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 1,
    cwd: "/w",
    model: "prov/model-x",
    messageCount: 0,
    streaming: false,
    compacting: false,
    dead: false,
    active: true,
    pendingDialog: false,
    attachedToYou: true,
    attachedElsewhere: false,
    ...over,
  };
}

const stats = { running: 2, waiting: 1, tokens: 0, cost: 0 };

describe("fleetStats", () => {
  it("counts running and waiting sessions and sums usage", () => {
    const result = fleetStats([
      meta({ streaming: true, tokens: 100, cost: 0.5 }),
      meta({ compacting: true, tokens: 20, cost: 0.1 }),
      meta({ pendingDialog: true, tokens: 50, cost: 0.25 }),
      meta({}),
    ]);
    assert.deepEqual(result, { running: 2, waiting: 1, tokens: 170, cost: 0.85 });
  });
});

describe("stateLabel", () => {
  it("names each lifecycle state", () => {
    assert.equal(stateLabel(undefined), "inactive");
    assert.equal(stateLabel(meta({ active: false })), "inactive");
    assert.equal(stateLabel(meta({ streaming: true })), "working");
    assert.equal(stateLabel(meta({ compacting: true })), "working");
    assert.equal(stateLabel(meta({ dead: true })), "crashed");
    assert.equal(stateLabel(meta()), "idle");
  });
});

describe("buildStatusLine", () => {
  const base = { switcherOpen: false, viewing: "/a", stats, flash: "" };

  it("shows name, model with provider, state, context, thinking level and cost - no fleet counts or hints", () => {
    const line = plain(
      buildStatusLine({
        ...base,
        meta: meta({
          sessionName: "alpha",
          model: "zai-coding-cn/glm-5.3-flash",
          provider: "zai-coding-cn",
          thinkingLevel: "high",
          ctxTokens: 45_200,
          ctxMax: 200_000,
          cost: 1.234,
        }),
      }),
    );
    assert.equal(line, "alpha | glm-5.3-flash (zai-coding-cn) | idle | ctx 45.2k/200.0k 23% | think high | $1.23");
  });

  it("says what the session is doing while it works", () => {
    const line = plain(buildStatusLine({ ...base, activity: "running bash", meta: meta({ streaming: true }) }));
    assert.match(line, /alpha|<unnamed>/);
    assert.match(line, /\| running bash/);
  });

  it("shows an unknown context (right after a compaction) as a question mark", () => {
    const line = plain(buildStatusLine({ ...base, meta: meta({ ctxTokens: null, ctxMax: 200_000 }) }));
    assert.match(line, /ctx \?\/200\.0k/);
  });

  it("drops the least important segments first on a narrow terminal, keeping the name and state", () => {
    const m = meta({
      sessionName: "alpha",
      model: "zai-coding-cn/glm-5.3-flash",
      provider: "zai-coding-cn",
      thinkingLevel: "high",
      ctxTokens: 45_200,
      ctxMax: 200_000,
      cost: 1.234,
    });
    const narrow = plain(buildStatusLine({ ...base, meta: m, width: 40 }));
    assert.ok(narrow.length <= 40, narrow);
    assert.match(narrow, /^alpha \| idle/);
    assert.doesNotMatch(narrow, /think/);
  });

  it("flags view-only and live-in-pi sessions", () => {
    const line = plain(buildStatusLine({ ...base, meta: meta({ attachedElsewhere: true, externallyLive: true }) }));
    assert.match(line, /VIEW-ONLY \| LIVE-IN-PI/);
  });

  it("hides the placeholder model of a session that is still loading", () => {
    const line = plain(buildStatusLine({ ...base, meta: meta({ model: "loading" }) }));
    assert.doesNotMatch(line, /loading/);
  });

  it("shows only fleet counts when no session is on screen", () => {
    assert.equal(plain(buildStatusLine({ ...base, viewing: null })), "2 running, 1 waiting | left: switcher");
  });

  it("describes the highlighted row while the switcher is open", () => {
    const line = plain(buildStatusLine({ ...base, switcherOpen: true, selectedName: "alpha" }));
    assert.match(line, /^switcher - alpha - enter open/);
  });

  it("lets a transient notification replace the status", () => {
    assert.equal(plain(buildStatusLine({ ...base, flash: "aborted" })), "aborted");
  });

  it("lets a pending permission dialog take over the line, even over a notification", () => {
    const dialog = { id: "1", method: "confirm", title: "Run it?" };
    assert.match(plain(buildStatusLine({ ...base, flash: "aborted", dialog })), /^PERMISSION pending/);
  });
});
