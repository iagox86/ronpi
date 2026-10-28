// Tab completion and listing for agent profiles.
import type { AgentProfile } from "./agents.ts";
import type { Choice } from "./cli.ts";

/**
 * After "/new ... -a " or "--agent ": the agent names that start with what was
 * typed, each with its description. The value replaces the whole line typed
 * after the command, like the other completers.
 */
export function agentCompletions(typed: string, agents: ReadonlyArray<{ name: string; description: string }>): Choice[] {
  const m = /^(.*?(?:^|\s)(?:-a|--agent)[ =])(\S*)$/.exec(typed);
  if (!m) {
    return [];
  }
  const [, head = "", prefix = ""] = m;
  return agents
    .filter((a) => a.name.startsWith(prefix.toLowerCase()))
    .map((a) => ({ value: `${head}${a.name}`, description: a.description }));
}

/** The /agents panel. */
export function agentListing(agents: readonly AgentProfile[], problems: readonly string[]): string {
  if (agents.length === 0 && problems.length === 0) {
    return "No agent profiles found.\n\nPut *.md files in agents/ (ronpi repo), ~/.config/ronpi/agents/ or <project>/.ronpi/agents/.";
  }
  const width = Math.max(0, ...agents.map((a) => a.name.length));
  const rows = agents.map((a) => {
    const bits = [a.model ?? "default model", a.tools ? `tools: ${a.tools.join(",")}` : "default tools", a.source];
    return `${a.name.padEnd(width)}  ${a.description}\n${" ".repeat(width)}  ${bits.join(" | ")}`;
  });
  const issues = problems.length > 0 ? `\n\nProblems:\n${problems.map((p) => `  ${p}`).join("\n")}` : "";
  return `Agent profiles (/new --agent <name>)\n\n${rows.join("\n")}${issues}`;
}
