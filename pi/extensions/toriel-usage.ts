// toriel usage: reports the account's quota / spend for the session's provider
// to toriel, which shows it in its status bar. Runs only in children the toriel
// daemon starts (TORIEL_CHILD), so plain pi sessions are untouched.
//
// The API key never leaves this process: the key is looked up through pi's own
// model registry, used for one request to the provider, and only the resulting
// percentages go back, as a setStatus record under "toriel-usage" (JSON, see
// UsageReport in src/shared.ts). toriel normalizes by provider, so a new
// provider is one adapter here, and a non-pi backend (Claude Code) can produce
// the same report from its own data.
//
// Adapters (provider chosen by the model's base URL):
//   z.ai / bigmodel.cn  GET <origin>/api/monitor/usage/quota/limit  (5h and weekly token windows)
//   LiteLLM             GET <origin>/key/info                        (spend vs max_budget)
//                       or, when the key may not call that route, the x-litellm-key-spend
//                       header on every ordinary response (spend only; the budget is unknown)
// Bifrost has no documented read endpoint for a virtual key's usage yet.
//
// The same numbers are offered to the agent as the `toriel_usage` tool, so it can
// check how much of the budget is left before starting something large.

// Only the slice of pi's extension API this file uses, so it type-checks (and is
// testable) without pi's packages on its import path.
interface Ctx {
  model?: { provider: string; baseUrl: string };
  sessionManager?: { getBranch(): Array<{ type?: string; message?: { role?: string; usage?: { totalTokens?: number; cost?: { total?: number } } } }> };
  modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
  ui: { setStatus(key: string, text: string | undefined): void };
}
interface Pi {
  on(event: "session_start" | "model_select" | "agent_end", handler: (event: unknown, ctx: Ctx) => void): unknown;
  on(event: "after_provider_response", handler: (event: { headers: Record<string, string> }, ctx: Ctx) => void): unknown;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    parameters: unknown;
    execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
}

export const STATUS_KEY = "toriel-usage";
const MIN_INTERVAL_MS = 60_000;
const TIMEOUT_MS = 5_000;

export interface UsageWindow {
  label: string;
  pct: number;
  resetsAt?: number;
  /** Credits used and the window's allowance, when the provider says (z.ai plans are credit-based). */
  used?: number;
  limit?: number;
}

export interface UsageReport {
  v: 1;
  provider: string;
  source: "zai" | "litellm";
  plan?: string;
  windows: UsageWindow[];
  spend?: { used: number; max?: number; resetsAt?: number };
  at: number;
}

export type AdapterName = "zai" | "litellm";

/**
 * Which adapter, if any, serves a provider. z.ai is recognised by its hosts;
 * LiteLLM by the provider id or host containing "litellm" (it is a self-hosted
 * proxy, so there is no fixed host to match).
 */
export function adapterFor(provider: string, baseUrl: string | undefined): AdapterName | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl ?? "");
  } catch {
    return undefined;
  }
  if (url.hostname === "api.z.ai" || url.hostname === "open.bigmodel.cn") {
    return "zai";
  }
  if (/litellm/i.test(provider) || /litellm/i.test(url.hostname)) {
    return "litellm";
  }
  return undefined;
}

/** z.ai's coding-plan quota: unit 3 = rolling 5h, 6 = weekly (5 = monthly, not shown). */
export function parseZai(json: unknown): { plan?: string; windows: UsageWindow[] } | undefined {
  const body = json as { code?: number; data?: { level?: string; limits?: Array<{ unit?: number; percentage?: number; nextResetTime?: number; usage?: number; currentValue?: number }> } };
  if (body?.code !== 200 || !Array.isArray(body.data?.limits)) {
    return undefined;
  }
  const labels: Record<number, string> = { 3: "5h", 6: "7d" };
  const windows: UsageWindow[] = [];
  for (const limit of body.data.limits) {
    const label = limit.unit === undefined ? undefined : labels[limit.unit];
    if (label && typeof limit.percentage === "number") {
      // z.ai's "usage" is the allowance and "currentValue" what has been used
      const credits = typeof limit.usage === "number" && typeof limit.currentValue === "number" ? { used: limit.currentValue, limit: limit.usage } : {};
      windows.push({ label, pct: limit.percentage, resetsAt: limit.nextResetTime, ...credits });
    }
  }
  windows.sort((a, b) => a.label.localeCompare(b.label)); // "5h" before "7d"
  return { plan: body.data?.level, windows };
}

/** LiteLLM /key/info: spend against max_budget (the budget may be unset). */
export function parseLitellm(json: unknown): { used: number; max?: number; resetsAt?: number } | undefined {
  const info = (json as { info?: { spend?: number; max_budget?: number | null; budget_reset_at?: string | null } })?.info;
  if (typeof info?.spend !== "number") {
    return undefined;
  }
  const reset = info.budget_reset_at ? Date.parse(info.budget_reset_at) : NaN;
  return {
    used: info.spend,
    max: typeof info.max_budget === "number" ? info.max_budget : undefined,
    resetsAt: Number.isNaN(reset) ? undefined : reset,
  };
}

const fmtLeft = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? ` ${m % 60}m` : ""}` : `${Math.floor(h / 24)}d`;
};

/** What the agent is told: plain sentences, with the time until each limit resets. */
export function describeUsage(report: UsageReport, now = Date.now()): string {
  const reset = (at: number | undefined) => (at && at > now ? `, resets in ${fmtLeft(at - now)}` : "");
  const lines = [`Provider ${report.provider}${report.plan ? ` (plan: ${report.plan})` : ""}:`];
  if (report.source === "zai") {
    for (const w of report.windows) {
      const credits = w.used !== undefined && w.limit !== undefined ? ` (${w.used.toLocaleString("en-US")} of ${w.limit.toLocaleString("en-US")} credits, ${Math.max(0, w.limit - w.used).toLocaleString("en-US")} left)` : "";
      lines.push(`- ${w.label} window: ${Math.round(w.pct)}% used${credits}${reset(w.resetsAt)}`);
    }
  } else if (report.spend) {
    const { used, max, resetsAt } = report.spend;
    lines.push(
      max
        ? `- budget: $${used.toFixed(2)} of $${max.toFixed(2)} used (${Math.round((used / max) * 100)}%)${reset(resetsAt)}`
        : `- spend: $${used.toFixed(2)} so far in the current budget period (no budget limit set)${reset(resetsAt)}`,
    );
  }
  lines.push(`(checked ${fmtLeft(Math.max(0, now - report.at))} ago)`);
  return lines.join("\n");
}

/**
 * LiteLLM reports the key's running spend on every response. The budget is not
 * in the headers (unless a newer version adds x-litellm-key-max-budget), so it
 * is carried over from an earlier /key/info report when there was one.
 */
export function reportFromHeaders(provider: string, headers: Record<string, string>, prev: UsageReport | undefined, now = Date.now()): UsageReport | undefined {
  const get = (name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
  const used = Number.parseFloat(get("x-litellm-key-spend") ?? "");
  if (!Number.isFinite(used)) {
    return undefined;
  }
  const headerMax = Number.parseFloat(get("x-litellm-key-max-budget") ?? "");
  const max = Number.isFinite(headerMax) ? headerMax : prev?.spend?.max;
  const resetsAt = prev?.spend?.resetsAt;
  const windows = max ? [{ label: "budget", pct: (used / max) * 100, resetsAt }] : [];
  return { v: 1, provider, source: "litellm", windows, spend: { used, max, resetsAt }, at: now };
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown | undefined> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    return res.status === 401 ? Symbol.for("unauthorized") : undefined;
  }
  return res.json();
}

export async function fetchReport(adapter: AdapterName, provider: string, baseUrl: string, key: string): Promise<UsageReport | undefined> {
  const origin = new URL(baseUrl).origin;
  const now = Date.now();
  if (adapter === "zai") {
    const url = `${origin}/api/monitor/usage/quota/limit`;
    // docs disagree on whether the key takes a Bearer prefix: try it, then the bare key
    let json = await getJson(url, { Authorization: `Bearer ${key}` });
    if (json === Symbol.for("unauthorized")) {
      json = await getJson(url, { Authorization: key });
    }
    const parsed = typeof json === "object" ? parseZai(json) : undefined;
    return parsed && parsed.windows.length > 0 ? { v: 1, provider, source: "zai", ...parsed, at: now } : undefined;
  }
  const json = await getJson(`${origin}/key/info`, { Authorization: `Bearer ${key}` });
  const spend = typeof json === "object" ? parseLitellm(json) : undefined;
  if (!spend) {
    return undefined;
  }
  const windows = spend.max ? [{ label: "budget", pct: (spend.used / spend.max) * 100, resetsAt: spend.resetsAt }] : [];
  return { v: 1, provider, source: "litellm", windows, spend, at: now };
}

export default function (pi: Pi) {
  if (!process.env.TORIEL_CHILD) {
    return;
  }
  let last = 0;
  let inFlight = false;
  let latest: UsageReport | undefined;

  const refresh = async (ctx: Ctx, force = false, minIntervalMs = MIN_INTERVAL_MS): Promise<UsageReport | undefined> => {
    const model = ctx.model;
    if (!model || inFlight || (!force && Date.now() - last < minIntervalMs)) {
      return latest;
    }
    const adapter = adapterFor(model.provider, model.baseUrl);
    if (!adapter) {
      return undefined;
    }
    inFlight = true;
    last = Date.now();
    try {
      const key = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
      if (!key) {
        return latest;
      }
      const report = await fetchReport(adapter, model.provider, model.baseUrl, key);
      if (report) {
        latest = report;
        ctx.ui.setStatus(STATUS_KEY, JSON.stringify(report));
      }
    } catch {
      // usage is a nicety: a failed lookup must never disturb the session
    } finally {
      inFlight = false;
    }
    return latest;
  };

  pi.on("session_start", (_event, ctx) => void refresh(ctx, true));
  pi.on("model_select", (_event, ctx) => void refresh(ctx, true));
  pi.on("agent_end", (_event, ctx) => void refresh(ctx));

  // Free numbers from ordinary traffic: also covers keys that may not call /key/info.
  let lastHeaderReport = 0;
  pi.on("after_provider_response", (event, ctx) => {
    const model = ctx.model;
    if (!model || adapterFor(model.provider, model.baseUrl) !== "litellm" || Date.now() - lastHeaderReport < 5_000) {
      return;
    }
    const report = reportFromHeaders(model.provider, event.headers, latest);
    if (report) {
      lastHeaderReport = Date.now();
      latest = report;
      ctx.ui.setStatus(STATUS_KEY, JSON.stringify(report));
    }
  });

  pi.registerTool({
    name: "toriel_usage",
    label: "Usage",
    description:
      "Shows how much of the account's quota or budget is used for the current model's provider (percent per window, or spend against the budget, and when it resets), plus this session's token and cost totals. Use it before starting something large or expensive.",
    promptSnippet: "toriel_usage: how much of the provider quota/budget is used",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const report = await refresh(ctx, false, 15_000);
      const turns = (ctx.sessionManager?.getBranch() ?? []).filter((e) => e.type === "message" && e.message?.role === "assistant");
      const tokens = turns.reduce((sum, e) => sum + (e.message?.usage?.totalTokens ?? 0), 0);
      const cost = turns.reduce((sum, e) => sum + (e.message?.usage?.cost?.total ?? 0), 0);
      const session = `This session so far: ${tokens.toLocaleString("en-US")} tokens processed over ${turns.length} model calls${cost > 0 ? `, $${cost.toFixed(2)}` : ""}.`;
      const provider = ctx.model?.provider ?? "unknown";
      const quota = report
        ? describeUsage(report)
        : `No quota or budget information is available for provider ${provider} (only z.ai and LiteLLM are supported; for LiteLLM the figure appears after the first model response, and the key needs no special route).`;
      return { content: [{ type: "text", text: `${quota}\n${session}` }], details: { report } };
    },
  });
}
