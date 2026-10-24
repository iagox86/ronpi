import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStatusLine, fleetStats, stateLabel } from "../status.ts";
import type { SessionMeta } from "../shared.ts";

// Styling is ANSI; the assertions are about the text.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 1,
    cwd: "/w",
    model: "prov/model-x",
    messageCount: 0,
    streaming: false,
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
      meta({ pendingDialog: true, tokens: 50, cost: 0.25 }),
      meta({}),
    ]);
    assert.deepEqual(result, { running: 1, waiting: 1, tokens: 150, cost: 0.75 });
  });
});

describe("stateLabel", () => {
  it("names each lifecycle state", () => {
    assert.equal(stateLabel(undefined), "inactive");
    assert.equal(stateLabel(meta({ active: false })), "inactive");
    assert.equal(stateLabel(meta({ streaming: true })), "working");
    assert.equal(stateLabel(meta({ dead: true })), "crashed");
    assert.equal(stateLabel(meta()), "idle");
  });
});

describe("buildStatusLine", () => {
  const base = { switcherOpen: false, viewing: "/a", stats, flash: "" };

  it("shows name, model, state, usage and fleet counts for the viewed session", () => {
    const line = plain(buildStatusLine({ ...base, meta: meta({ sessionName: "alpha", tokens: 1500, cost: 1.234 }) }));
    assert.equal(line, "alpha | model-x | idle | 1.5k tok | $1.23 | 2 running, 1 waiting | left: switcher");
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
