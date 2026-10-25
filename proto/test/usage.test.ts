import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adapterFor, describeUsage, reportFromHeaders, parseLitellm, parseZai } from "../../pi/extensions/ronpi-usage.ts";
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

describe("describeUsage", () => {
  const NOW = 1_800_000_000_000;

  it("tells the agent each z.ai window's percent used and when it resets", () => {
    const text = describeUsage(
      { v: 1, provider: "zai", source: "zai", plan: "pro", windows: [{ label: "5h", pct: 16.4, resetsAt: NOW + 130 * 60_000 }, { label: "7d", pct: 4 }], at: NOW - 30_000 },
      NOW,
    );
    assert.match(text, /plan: pro/);
    assert.match(text, /5h window: 16% used, resets in 2h 10m/);
    assert.match(text, /7d window: 4% used\n/);
  });

  it("includes the credits left when z.ai reports them, and parses the real response shape", () => {
    const parsed = parseZai({
      code: 200,
      data: { level: "lite", limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 2500, remaining: 7500, percentage: 25, nextResetTime: NOW + 3600_000 }] },
    });
    const text = describeUsage({ v: 1, provider: "zai", source: "zai", plan: parsed?.plan, windows: parsed?.windows ?? [], at: NOW }, NOW);
    assert.match(text, /7d window: 25% used \(2,500 of 10,000 credits, 7,500 left\), resets in 1h/);
  });

  it("reports LiteLLM spend against its budget, or plain spend when there is no limit", () => {
    const base = { v: 1 as const, provider: "litellm", source: "litellm" as const, windows: [], at: NOW };
    assert.match(describeUsage({ ...base, spend: { used: 12.5, max: 50 } }, NOW), /\$12\.50 of \$50\.00 used \(25%\)/);
    assert.match(describeUsage({ ...base, spend: { used: 3 } }, NOW), /spend: \$3\.00 so far in the current budget period \(no budget limit set\)$/m);
    assert.match(describeUsage({ ...base, spend: { used: 3, resetsAt: NOW + 5 * 3600_000 } }, NOW), /no budget limit set\), resets in 5h/);
  });
});

describe("reportFromHeaders", () => {
  const NOW = 1_800_000_000_000;

  it("reads LiteLLM's running key spend from a response, whatever the header case", () => {
    const report = reportFromHeaders("litellm", { "X-LiteLLM-Key-Spend": "1.80" }, undefined, NOW);
    assert.equal(report?.spend?.used, 1.8);
    assert.deepEqual(report?.windows, []);
  });

  it("keeps the budget an earlier /key/info lookup found, so the percentage survives", () => {
    const prev = { v: 1 as const, provider: "litellm", source: "litellm" as const, windows: [], spend: { used: 1, max: 10 }, at: NOW - 1 };
    const report = reportFromHeaders("litellm", { "x-litellm-key-spend": "2.5" }, prev, NOW);
    assert.equal(report?.windows[0]?.pct, 25);
  });

  it("ignores responses without the header", () => {
    assert.equal(reportFromHeaders("litellm", { "content-type": "json" }, undefined, NOW), undefined);
  });
});
