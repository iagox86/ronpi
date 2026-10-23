import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { SessionMeta } from "../shared.ts";
import { loadSettings, resolveChildConfig, settingsFile, settingsMtime } from "../settings.ts";
import { settingsNotice } from "../status.ts";

const tmp = (content?: string) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-set-")), "settings.json");
  if (content !== undefined) {
    fs.writeFileSync(f, content);
  }
  return f;
};

describe("loadSettings", () => {
  it("treats a missing file as no settings and no problems", () => {
    assert.deepEqual(loadSettings(tmp()), { settings: {}, problems: [] });
  });

  it("reads the supported keys", () => {
    const { settings, problems } = loadSettings(tmp('{"steeringMode":"one-at-a-time","model":"m","thinking":"low"}'));
    assert.deepEqual(settings, { steeringMode: "one-at-a-time", model: "m", thinking: "low" });
    assert.deepEqual(problems, []);
  });

  it("keeps the valid keys and reports bad values and unknown keys", () => {
    const { settings, problems } = loadSettings(tmp('{"model":"m","steeringMode":"sideways","nope":1}'));
    assert.deepEqual(settings, { model: "m" });
    assert.equal(problems.length, 2);
  });

  it("reports unparseable JSON without throwing", () => {
    const { settings, problems } = loadSettings(tmp("{ not json"));
    assert.deepEqual(settings, {});
    assert.equal(problems.length, 1);
  });
});

describe("resolveChildConfig", () => {
  it("defaults to delivering all queued messages", () => {
    assert.equal(resolveChildConfig({}, {}).steeringMode, "all");
  });

  it("lets the environment override the file", () => {
    const cfg = resolveChildConfig({ model: "from-file", steeringMode: "all" }, { RONPI_MODEL: "from-env", RONPI_STEERING_MODE: "one-at-a-time" });
    assert.equal(cfg.model, "from-env");
    assert.equal(cfg.steeringMode, "one-at-a-time");
  });
});

describe("settingsFile / settingsMtime", () => {
  it("honors RONPI_SETTINGS, then XDG_CONFIG_HOME", () => {
    assert.equal(settingsFile({ RONPI_SETTINGS: "/x/s.json" }), "/x/s.json");
    assert.equal(settingsFile({ XDG_CONFIG_HOME: "/cfg", HOME: "/h" }), "/cfg/ronpi/settings.json");
    assert.equal(settingsFile({ HOME: "/h" }), "/h/.config/ronpi/settings.json");
  });

  it("is null for a missing file", () => {
    assert.equal(settingsMtime(tmp()), null);
  });
});

const meta = (over: Partial<SessionMeta>): SessionMeta => ({ id: 1, active: true, settingsMtime: 100, ...over }) as SessionMeta;

describe("settingsNotice", () => {
  it("is silent when every running session has the current settings", () => {
    assert.equal(settingsNotice([meta({}), meta({ id: 2 })], 100), "");
  });

  it("counts running sessions started before the file changed", () => {
    assert.match(settingsNotice([meta({}), meta({ id: 2, settingsMtime: 50 })], 100), /1 running session uses the old values/);
    assert.match(settingsNotice([meta({ settingsMtime: 1 }), meta({ id: 2, settingsMtime: 2 })], 100), /2 running sessions use/);
  });

  it("ignores inactive sessions, which pick the new settings up when they start", () => {
    assert.equal(settingsNotice([meta({ active: false, settingsMtime: undefined })], 100), "");
  });

  it("treats a file created or removed since a session started as a change", () => {
    assert.match(settingsNotice([meta({ settingsMtime: null })], 100), /settings changed/);
    assert.match(settingsNotice([meta({ settingsMtime: 100 })], null), /settings changed/);
  });

  it("surfaces a settings problem when nothing is stale", () => {
    assert.match(settingsNotice([meta({ settingsProblem: "bad json" })], 100), /settings problem: bad json/);
  });
});

import { buildStatusLine, fleetStats } from "../status.ts";

describe("switcher status line", () => {
  const inputs = { switcherOpen: true, viewing: null, stats: fleetStats([]), flash: "", selectedName: "x" };
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  it("puts a settings warning first, ahead of the key hints", () => {
    const line = plain(buildStatusLine({ ...inputs, notice: "settings changed - 1 running session uses the old values" }));
    assert.match(line, /^switcher \| settings changed/);
    assert.doesNotMatch(line, /enter open/);
  });

  it("shows the key hints when there is no warning", () => {
    assert.match(plain(buildStatusLine(inputs)), /enter open/);
  });
});
