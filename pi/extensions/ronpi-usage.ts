// ronpi usage: reports the account's quota / spend for the session's provider
// to ronpi, which shows it in its status bar. Runs only in children the ronpi
// daemon starts (RONPI_CHILD), so plain pi sessions are untouched.
//
// The API key never leaves this process: the key is looked up through pi's own
// model registry, used for one request to the provider, and only the resulting
// percentages go back, as a setStatus record under "ronpi-usage" (JSON, see
// UsageReport in proto/shared.ts). ronpi normalizes by provider, so a new
// provider is one adapter here, and a non-pi backend (Claude Code) can produce
// the same report from its own data.
//
// Adapters (provider chosen by the model's base URL):
//   z.ai / bigmodel.cn  GET <origin>/api/monitor/usage/quota/limit  (5h and weekly token windows)
//   LiteLLM             GET <origin>/key/info                        (spend vs max_budget)
// Bifrost has no documented read endpoint for a virtual key's usage yet.

// Only the slice of pi's extension API this file uses, so it type-checks (and is
// testable) without pi's packages on its import path.
interface Ctx {
  model?: { provider: string; baseUrl: string };
  modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
  ui: { setStatus(key: string, text: string | undefined): void };
}
interface Pi {
  on(event: "session_start" | "model_select" | "agent_end", handler: (event: unknown, ctx: Ctx) => void): unknown;
}

export const STATUS_KEY = "ronpi-usage";
const MIN_INTERVAL_MS = 60_000;
const TIMEOUT_MS = 5_000;

export interface UsageWindow {
  label: string;
  pct: number;
  resetsAt?: number;
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
  const body = json as { code?: number; data?: { level?: string; limits?: Array<{ unit?: number; percentage?: number; nextResetTime?: number }> } };
  if (body?.code !== 200 || !Array.isArray(body.data?.limits)) {
    return undefined;
  }
  const labels: Record<number, string> = { 3: "5h", 6: "7d" };
  const windows: UsageWindow[] = [];
  for (const limit of body.data.limits) {
    const label = limit.unit === undefined ? undefined : labels[limit.unit];
    if (label && typeof limit.percentage === "number") {
      windows.push({ label, pct: limit.percentage, resetsAt: limit.nextResetTime });
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
  if (!process.env.RONPI_CHILD) {
    return;
  }
  let last = 0;
  let inFlight = false;

  const refresh = async (ctx: Ctx, force = false) => {
    const model = ctx.model;
    if (!model || inFlight || (!force && Date.now() - last < MIN_INTERVAL_MS)) {
      return;
    }
    const adapter = adapterFor(model.provider, model.baseUrl);
    if (!adapter) {
      return;
    }
    inFlight = true;
    last = Date.now();
    try {
      const key = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
      if (!key) {
        return;
      }
      const report = await fetchReport(adapter, model.provider, model.baseUrl, key);
      if (report) {
        ctx.ui.setStatus(STATUS_KEY, JSON.stringify(report));
      }
    } catch {
      // usage is a nicety: a failed lookup must never disturb the session
    } finally {
      inFlight = false;
    }
  };

  pi.on("session_start", (_event, ctx) => void refresh(ctx, true));
  pi.on("model_select", (_event, ctx) => void refresh(ctx, true));
  pi.on("agent_end", (_event, ctx) => void refresh(ctx));
}
