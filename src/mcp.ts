// pi's /mcp command prints its status as plain text; this reads it back into
// records toriel can list and complete from.
import * as fs from "node:fs";
import * as path from "node:path";

export interface McpServer {
  name: string;
  /** Everything after "name: " on its line, e.g. "connected, 12 tools (direct)". */
  detail: string;
}

/** Lines of the /mcp status that are about the configuration, not about one server. */
const NOT_SERVERS = new Set(["config error", "overridden"]);

/** One unindented "name: state ..." line per server; indented lines continue the one above (e.g. an error's stderr tail). */
const SERVER_LINE = /^([^\s:][^:]*?): (.+)$/;

/**
 * Parse /mcp's status text: one unindented "name: state ..." line per server
 * (indented lines continue the one above, e.g. an error's stderr tail).
 */
export function parseMcpStatus(text: string): McpServer[] {
  const servers: McpServer[] = [];
  for (const line of text.split("\n")) {
    const m = SERVER_LINE.exec(line);
    if (m && !NOT_SERVERS.has(m[1] as string)) {
      servers.push({ name: m[1] as string, detail: m[2] as string });
    }
  }
  return servers;
}

export const MCP_ACTIONS = ["list", "status", "explore", "add", "remove", "reconnect", "login", "logout"] as const;
export type McpAction = (typeof MCP_ACTIONS)[number];

export interface Completion {
  value: string;
  description?: string;
}

/**
 * What to offer after "/mcp ": the actions while the first word is being typed,
 * then (for actions that take one) the servers whose name starts with the
 * second word. A value replaces the whole text typed after the command, the way
 * pi's own completer builds them.
 */
export function mcpCompletions(typed: string, servers: readonly McpServer[]): Completion[] {
  const hasSpace = /\s/.test(typed.trimStart());
  const [action = "", prefix = ""] = typed.trimStart().split(/\s+/);
  if (!hasSpace) {
    return MCP_ACTIONS.filter((a) => a.startsWith(action.toLowerCase())).map((a) => ({
      value: a === "list" ? a : `${a} `,
      description:
        a === "list"
          ? "show every server with its state"
          : a === "status"
            ? "troubleshoot: state, error, configuration and checks for each server"
          : a === "add"
            ? "add a server: add <name> <url | command args...>"
            : a === "remove"
              ? "remove a server from mcp.json (tab completes its name)"
              : a === "explore"
                ? "have the agent introspect a server and write a skill for it (tab completes its name)"
                : `${a} a server (tab completes its name)`,
    }));
  }
  if (!(MCP_ACTIONS as readonly string[]).includes(action) || action === "list" || action === "add") {
    return [];
  }
  return servers
    .filter((s) => s.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((s) => ({ value: `${action} ${s.name}`, description: s.detail }));
}

export interface McpEntry {
  url?: string;
  command?: string;
  args?: string[];
}

/** pi's mcp.json: a URL means a remote server, anything else is a command to run over stdio. */
export function mcpEntry(target: readonly string[]): McpEntry {
  const [first, ...rest] = target;
  if (!first) {
    throw new Error("give a URL or a command to run");
  }
  if (/^https?:\/\//i.test(first)) {
    if (rest.length > 0) {
      throw new Error("a URL takes no further arguments");
    }
    return { url: first };
  }
  return rest.length > 0 ? { command: first, args: rest } : { command: first };
}

/** Where pi reads its MCP servers from. */
export function mcpConfigFile(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent");
  return path.join(agentDir, "mcp.json");
}

/**
 * The name of a skill for `name` under any of the skills dirs `dirs` (the
 * agent dir's own skills/ plus any extension-provided skills roots like
 * <extension>/skills): a skill directory whose name contains it
 * (case-insensitive). A missing dir means no skills at all.
 * Earlier dirs win, and within a dir the first matching entry.
 */
export function skillForServer(dirs: string[], name: string): string | undefined {
  for (const dir of dirs) {
    const skill = skillInDir(dir, name);
    if (skill !== undefined) {
      return skill;
    }
  }
  return undefined;
}

function skillInDir(dir: string, name: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const needle = name.toLowerCase();
  for (const entry of entries) {
    if (entry.toLowerCase().includes(needle)) {
      return entry;
    }
  }
  return undefined;
}

/**
 * The /mcp list panel's lines: pi's status text with every server line
 * extended by that server's skill presence ("skill: <name>" or "no matching
 * skill (/mcp explore <name>)"; the state text is kept whole). Lines that are
 * not about one server (indented error tails, "config error", "overridden",
 * the none-configured message) pass through unchanged.
 */
export function mcpListLines(text: string, skillsDirs: string[]): string[] {
  return text.split("\n").map((line) => {
    const m = SERVER_LINE.exec(line);
    if (!m || NOT_SERVERS.has(m[1] as string)) {
      return line;
    }
    const skill = skillForServer(skillsDirs, m[1] as string);
    return `${line} - ${skill ? `skill: ${skill}` : `no matching skill (/mcp explore ${m[1]})`}`;
  });
}

/** Whether `name` is listed as connected in /mcp's status text (as parsed by parseMcpStatus). */
export function mcpServerConnected(text: string, name: string): boolean {
  const server = parseMcpStatus(text).find((s) => s.name === name);
  return server !== undefined && /^connected/i.test(server.detail);
}

/**
 * Add `name` to the mcp.json at `file`, keeping every other key as it was.
 * Refuses to replace an existing server or to touch a file that is not valid JSON.
 */
export function addMcpServer(file: string, name: string, entry: McpEntry): void {
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`${file} is not valid JSON (${err instanceof Error ? err.message : err}); fix it by hand first`);
    }
  }
  const servers = config.mcpServers ?? {};
  if (Object.hasOwn(servers, name)) {
    throw new Error(`server "${name}" already exists in ${file}`);
  }
  config.mcpServers = { ...servers, [name]: entry };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Remove `name` from the mcp.json at `file`, keeping every other key. Throws a
 * message that says where the server is defined when it is not in this file
 * (`elsewhere` lists other config files to look in).
 */
export function removeMcpServer(file: string, name: string, elsewhere: readonly string[] = []): void {
  let config: { mcpServers?: Record<string, unknown> };
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      config = {};
    } else {
      throw new Error(`${file} is not valid JSON (${err instanceof Error ? err.message : err}); fix it by hand first`);
    }
  }
  const servers = config.mcpServers ?? {};
  if (!Object.hasOwn(servers, name)) {
    const where = elsewhere.filter((f) => configuredMcpNames(f).includes(name));
    throw new Error(
      where.length > 0
        ? `"${name}" is not in ${file}; it is defined in ${where.join(", ")} - remove it there`
        : `"${name}" is not in ${file} (a server registered by an extension cannot be removed here)`,
    );
  }
  const { [name]: _gone, ...rest } = servers;
  config.mcpServers = rest;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function configuredMcpNames(file: string): string[] {
  try {
    return Object.keys((JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {});
  } catch {
    return [];
  }
}
