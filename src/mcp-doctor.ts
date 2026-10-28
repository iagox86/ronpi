// /mcp status: why is an MCP server not working? Joins what pi reports for a
// server (its state and the error text under it) with what is configured for it
// in mcp.json and a few cheap local checks (is the command installed, does the
// URL's host answer), and says what to try. Secrets never appear: env and header
// values are shown as names only, and arguments that follow a token-like flag are masked.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { onPath } from "./clipboard.ts";

export interface McpConfigEntry {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  cwd?: string;
}

export interface ServerStatus {
  name: string;
  /** The state line, e.g. "failed (direct)". */
  detail: string;
  /** Indented lines under it: the error and the tail of the server's stderr. */
  notes: string[];
}

const NOT_SERVERS = new Set(["config error", "overridden"]);

/** pi's /mcp status text as one record per server, keeping the error lines under each. */
export function parseStatusDetailed(text: string): { servers: ServerStatus[]; configErrors: string[] } {
  const servers: ServerStatus[] = [];
  const configErrors: string[] = [];
  let current: ServerStatus | undefined;
  for (const line of text.split("\n")) {
    const m = /^([^\s:][^:]*?): (.+)$/.exec(line);
    if (m) {
      if (m[1] === "config error") {
        configErrors.push(m[2] as string);
        current = undefined;
      } else if (NOT_SERVERS.has(m[1] as string)) {
        current = undefined;
      } else {
        current = { name: m[1] as string, detail: m[2] as string, notes: [] };
        servers.push(current);
      }
    } else if (current && /^\s+\S/.test(line)) {
      current.notes.push(line.trim());
    }
  }
  return { servers, configErrors };
}

const SECRET_FLAG = /token|key|secret|passw|auth|bearer/i;

/** Lines describing how a server is started, with secrets left out. */
export function describeEntry(entry: McpConfigEntry): string[] {
  const lines: string[] = [];
  if (entry.url) {
    lines.push(`url: ${entry.url.replace(/\/\/[^/@]*@/, "//***@").replace(/([?&][^=&]*(?:token|key|secret)[^=&]*)=[^&]*/gi, "$1=***")}`);
  }
  if (entry.command) {
    const masked: string[] = [];
    let hide = false;
    for (const arg of entry.args ?? []) {
      if (hide) {
        masked.push("***");
        hide = false;
      } else if (/^--?[^=]+=/.test(arg) && SECRET_FLAG.test(arg.split("=")[0] as string)) {
        masked.push(`${arg.split("=")[0]}=***`);
      } else {
        masked.push(arg);
        hide = /^--?\w/.test(arg) && SECRET_FLAG.test(arg);
      }
    }
    lines.push(`command: ${[entry.command, ...masked].join(" ")}`);
  }
  if (entry.cwd) {
    lines.push(`cwd: ${entry.cwd}`);
  }
  if (entry.env && Object.keys(entry.env).length > 0) {
    lines.push(`env: ${Object.keys(entry.env).join(", ")} (values hidden)`);
  }
  if (entry.headers && Object.keys(entry.headers).length > 0) {
    lines.push(`headers: ${Object.keys(entry.headers).join(", ")} (values hidden)`);
  }
  if (entry.enabled === false) {
    lines.push("enabled: false");
  }
  return lines;
}

export interface Checks {
  /** Is `cmd` a program on the PATH? */
  onPath(cmd: string): boolean;
  /** Is there an executable file at this path? */
  executable(file: string): boolean;
  /** Does something accept TCP connections at host:port? */
  reachable(host: string, port: number): Promise<boolean>;
}

export const realChecks: Checks = {
  onPath: (cmd) => onPath(cmd),
  executable: (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  reachable: (host, port) =>
    new Promise((resolve) => {
      const s = net.connect({ host, port });
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(3_000, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    }),
};

/** Findings from cheap local checks of one configured server; empty means nothing looked wrong. */
export async function probeEntry(entry: McpConfigEntry, checks: Checks = realChecks, home = process.env.HOME ?? ""): Promise<string[]> {
  const findings: string[] = [];
  if (entry.command) {
    const cmd = entry.command.replace(/^~(?=\/)/, home);
    const found = cmd.includes("/") ? checks.executable(cmd) : checks.onPath(cmd);
    if (!found) {
      findings.push(`the command "${entry.command}" was not found${cmd.includes("/") ? "" : " on the PATH"} - install it, or give the full path`);
    }
  }
  if (entry.url) {
    try {
      const u = new URL(entry.url);
      const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
      if (!(await checks.reachable(u.hostname, port))) {
        findings.push(`nothing is accepting connections at ${u.hostname}:${port} - is the server running, and is the address right?`);
      }
    } catch {
      findings.push(`"${entry.url}" is not a valid URL`);
    }
  }
  if (!entry.command && !entry.url) {
    findings.push("the entry has neither a command nor a url");
  }
  return findings;
}

/** What to try, from the state pi reports and the error text under it. */
export function adviceFor(status: ServerStatus, entry: McpConfigEntry | undefined): string[] {
  const text = `${status.detail}\n${status.notes.join("\n")}`;
  const out: string[] = [];
  if (/needs sign-in|unauthorized|401/i.test(text)) {
    out.push(`sign in: /mcp login ${status.name}`);
  }
  if (/disabled/i.test(status.detail) || entry?.enabled === false) {
    out.push('it is switched off: set "enabled": true in mcp.json (or enable it in pi\'s own /mcp panel), then /reload');
  }
  if (/ENOENT|not found|no such file/i.test(text)) {
    out.push("the program to start could not be run: check the command and that its dependencies are installed");
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|fetch failed/i.test(text)) {
    out.push("the server could not be reached: start it, or fix the URL / network");
  }
  if (/EACCES|permission denied/i.test(text)) {
    out.push("permission denied: check the file permissions of the command");
  }
  if (/timed out|timeout/i.test(text)) {
    out.push("it took too long to answer: it may be slow to start; /mcp reconnect " + status.name + " once it is up");
  }
  if (/failed|error|disconnected/i.test(status.detail) && out.length === 0) {
    out.push(`read the error above, fix the cause, then /mcp reconnect ${status.name}`);
  }
  if (/failed|error|disconnected/i.test(status.detail) && !out.some((o) => o.includes("reconnect"))) {
    out.push(`when fixed: /mcp reconnect ${status.name} (or /reload for a changed mcp.json)`);
  }
  return out;
}

/** The /mcp status panel text. `only` limits it to one server. */
export function statusReport(
  parsed: { servers: ServerStatus[]; configErrors: string[] },
  configs: ReadonlyMap<string, { entry: McpConfigEntry; file: string }>,
  findings: ReadonlyMap<string, string[]>,
  only?: string,
): string {
  const shown = only ? parsed.servers.filter((s) => s.name === only) : parsed.servers;
  const blocks = shown.map((s) => {
    const cfg = configs.get(s.name);
    const healthy = /^connected/i.test(s.detail);
    const lines = [`${healthy ? "OK  " : "!!  "}${s.name}: ${s.detail}`];
    for (const n of s.notes) {
      lines.push(`      ${n}`);
    }
    if (cfg) {
      lines.push(`    configured in ${cfg.file}`);
      for (const d of describeEntry(cfg.entry)) {
        lines.push(`      ${d}`);
      }
    } else {
      lines.push("    not in any mcp.json (registered by an extension)");
    }
    for (const f of findings.get(s.name) ?? []) {
      lines.push(`    check: ${f}`);
    }
    if (!healthy) {
      for (const a of adviceFor(s, cfg?.entry)) {
        lines.push(`    try: ${a}`);
      }
    }
    return lines.join("\n");
  });
  const head = only && shown.length === 0 ? `No server called ${only} (/mcp shows them all).` : "";
  const errors = parsed.configErrors.length > 0 ? `\n\nConfig problems:\n${parsed.configErrors.map((e) => `  ${e}`).join("\n")}` : "";
  const sick = shown.filter((s) => !/^connected/i.test(s.detail)).length;
  const summary = shown.length > 0 ? `MCP status: ${shown.length - sick} of ${shown.length} connected\n\n` : "";
  return `${summary}${head}${blocks.join("\n\n")}${errors}`.trim() || "No MCP servers are configured. /mcp add <name> <url | command> adds one.";
}

/** Server entries from the given mcp.json files; a later file wins, like pi's project-over-user rule. */
export function readConfigs(files: readonly string[]): Map<string, { entry: McpConfigEntry; file: string }> {
  const map = new Map<string, { entry: McpConfigEntry; file: string }>();
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, McpConfigEntry> };
      for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
        map.set(name, { entry, file: path.resolve(file) });
      }
    } catch {
      // a missing or broken file simply contributes nothing; pi reports config errors itself
    }
  }
  return map;
}
