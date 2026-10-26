// pi's /mcp command prints its status as plain text; this reads it back into
// records ronpi can list and complete from.

export interface McpServer {
  name: string;
  /** Everything after "name: " on its line, e.g. "connected, 12 tools (direct)". */
  detail: string;
}

/** Lines of the /mcp status that are about the configuration, not about one server. */
const NOT_SERVERS = new Set(["config error", "overridden"]);

/**
 * Parse /mcp's status text: one unindented "name: state ..." line per server
 * (indented lines continue the one above, e.g. an error's stderr tail).
 */
export function parseMcpStatus(text: string): McpServer[] {
  const servers: McpServer[] = [];
  for (const line of text.split("\n")) {
    const m = /^([^\s:][^:]*?): (.+)$/.exec(line);
    if (m && !NOT_SERVERS.has(m[1] as string)) {
      servers.push({ name: m[1] as string, detail: m[2] as string });
    }
  }
  return servers;
}

export const MCP_ACTIONS = ["list", "reconnect", "login", "logout"] as const;
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
      description: a === "list" ? "show every server with its state" : `${a} a server (tab completes its name)`,
    }));
  }
  if (!(MCP_ACTIONS as readonly string[]).includes(action) || action === "list") {
    return [];
  }
  return servers
    .filter((s) => s.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((s) => ({ value: `${action} ${s.name}`, description: s.detail }));
}
