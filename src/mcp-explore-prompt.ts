// /mcp explore: the prompt asking the agent to introspect one MCP server and
// write a skill for it. Kept in its own module so the wording has a unit test
// without pulling in the TUI.

export function mcpExplorePrompt(server: string): string {
  return [
    `Write a skill for the MCP server "${server}" so that future agents can use it without rediscovering its shape.`,
    "If a SKILL.md for this server already exists, read it first and update it rather than overwriting it.",
    "Introspect the server first, using your own MCP inspection tools: its tools are in your MCP tool namespace, where you can list and describe them to get their full parameter schemas (and see its resources if it has any), and call a minimal one if describing is still not enough.",
    "Then write the skill in the skills/ folder of the pi agent directory (for example ~/.pi/agent/skills, or $PI_CODING_AGENT_DIR/skills when that is set), in a subdirectory named after the server or its topic, using a filesystem-safe name derived from the server name (lowercase, a-z, 0-9, - and _ only) so it is a valid path: <skills dir>/<server or topic name>/SKILL.md.",
    "Follow pi's skill format: a frontmatter with name and description; the description is what surfaces the skill to future agents, so make it say what the server is for and the phrases an agent would actually use.",
    "Cover: what the server is for, every tool with its parameters, gotchas (quirks, required sign-in, anything easy to get wrong), and one example call per important tool.",
    "Be factual: write only what the introspection shows, not what you guess.",
  ].join(" ");
}
