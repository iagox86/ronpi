import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adapterFor, parseLitellm, parseZai } from "../../pi/extensions/ronpi-usage.ts";
import type { SessionMeta, UsageReport } from "../shared.ts";
import { buildStatusLine, usageText } from "../status.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("usage adapters", () => {
  it("recognise z.ai on both its hosts and LiteLLM by name, and nothing else", () => {
    assert.equal(adapterFor("zai", "https://api.z.ai/api/coding/paas/v4"), "zai");
    assert.equal(adapterFor("zai-coding-cn", "https://open.bigmodel.cn/api/coding/paas/v4"), "zai");
    assert.equal(adapterFor("litellm", "https://litellm.example.com/v1"), "litellm");
    assert.equal(adapterFor("gw", "https://litellm.example.com/v1"), "litellm");
    assert.equal(adapterFor("ollama", "http://10.0.0.10:11434/v1"), undefined);
    assert.equal(adapterFor("x", undefined), undefined);
  });

  it("read z.ai's 5h and weekly windows by unit, not by position, ignoring the monthly one", () => {
    const parsed = parseZai({
      code: 200,
      data: {
        level: "lite",
        limits: [
          { type: "TOKENS_LIMIT", unit: 6, percentage: 4, nextResetTime: 2000 },
          { type: "TIME_LIMIT", unit: 5, percentage: 12, nextResetTime: 3000 },
          { type: "TOKENS_LIMIT", unit: 3, percentage: 16.5, nextResetTime: 1000 },
        ],
      },
    });
    assert.deepEqual(parsed, {
      plan: "lite",
      windows: [
        { label: "5h", pct: 16.5, resetsAt: 1000 },
        { label: "7d", pct: 4, resetsAt: 2000 },
      ],
    });
  });

  it("reject a z.ai reply that is not a success envelope", () => {
    assert.equal(parseZai({ code: 401, msg: "bad key" }), undefined);
    assert.equal(parseZai(null), undefined);
  });

  it("read LiteLLM spend and an optional budget", () => {
    assert.deepEqual(parseLitellm({ info: { spend: 3.5, max_budget: 25, budget_reset_at: "2026-11-01T00:00:00Z" } }), {
      used: 3.5,
      max: 25,
      resetsAt: Date.parse("2026-11-01T00:00:00Z"),
    });
    assert.deepEqual(parseLitellm({ info: { spend: 1, max_budget: null } }), { used: 1, max: undefined, resetsAt: undefined });
    assert.equal(parseLitellm({ info: {} }), undefined);
  });
});

describe("usage in the status bar", () => {
  const now = 10_000_000;
  const report = (over: Partial<UsageReport> = {}): UsageReport => ({
    v: 1,
    provider: "zai",
    source: "zai",
    windows: [
      { label: "5h", pct: 16 },
      { label: "7d", pct: 4 },
    ],
    at: now,
    ...over,
  });

  it("shows each window as a percent", () => {
    assert.equal(plain(usageText(report(), now)!), "5h 16% 7d 4%");
  });

  it("shows spend against a budget, or plain spend without one", () => {
    const budget = report({ source: "litellm", windows: [{ label: "budget", pct: 14 }], spend: { used: 3.5, max: 25 } });
    assert.equal(plain(usageText(budget, now)!), "budget 14% ($3.50/$25.00)");
    const open = report({ source: "litellm", windows: [], spend: { used: 3.5 } });
    assert.equal(plain(usageText(open, now)!), "spend $3.50");
  });

  it("hides a report that is too old to trust", () => {
    assert.equal(usageText(report({ at: now - 31 * 60_000 }), now), undefined);
    assert.equal(usageText(undefined, now), undefined);
  });

  it("puts usage between the context and the cost in the session bar", () => {
    const meta: SessionMeta = {
      id: 1,
      cwd: "/w",
      model: "zai/glm-5.3-flash",
      provider: "zai",
      messageCount: 0,
      streaming: false,
      dead: false,
      active: true,
      pendingDialog: false,
      attachedToYou: true,
      attachedElsewhere: false,
      ctxTokens: 1000,
      ctxMax: 200_000,
      cost: 2,
      usage: report({ at: Date.now() }),
    };
    const line = plain(buildStatusLine({ switcherOpen: false, viewing: "/a", stats: { running: 0, waiting: 0, tokens: 0, cost: 0 }, flash: "", meta }));
    assert.match(line, /ctx 1\.0k\/200\.0k 1% \| 5h 16% 7d 4% \| \$2\.00$/);
  });
});
