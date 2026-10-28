# Agent profiles

A profile is a markdown file: frontmatter that decides how a session launches, then the system prompt. Start one with `/new --agent <name>` (tab completes names), list them with `/agents`. Same shape as Claude Code's agent files, so those can be pasted in; ronpi does not read Claude's own folders.

Searched in order, a later folder replacing an earlier agent of the same name:

1. `agents/` in the ronpi repo (shipped)
2. `~/.config/ronpi/agents/` (yours)
3. `<project>/.ronpi/agents/` (this project only)

```
---
name: reverse-engineer          # required: lowercase letters, digits, - and _
description: What it is for.    # required: what picks the agent
tools: read, grep, bash, mcp__ghidra__*   # allowlist; patterns allowed; Claude names (Read, Glob) are mapped
model: litellm/gemma4:12b       # provider/id; default = your settings
thinking: low                   # off, minimal, low, medium, high, xhigh, max
extensions: false               # default true; false drops pi extensions (permission system, memory tools)
minimal: true                   # default true; skips AGENTS.md/CLAUDE.md, skills, prompt templates
maxTurns: 25                    # parsed now, enforced once subagents exist
budget: 150000                  # tokens; same
canSpawn: false                 # same
---
The system prompt, appended to pi's own.
```

What the launch does:

- `tools` becomes `--tools`. pi keeps MCP tools unless an entry starts with `mcp__`, so a profile with no `mcp__` entry also gets `--no-mcp`. **`--tools` does not remove tools that extensions add** (memory, skills, usage); use `extensions: false` for a bare agent.
- A profile with `mcp__server__*` tools only sees that server's tools, but pi still connects every enabled server in `mcp.json` when the session starts. There is no per-run server choice in pi. The loader warns when a pattern names a server that is not configured.
- `model` and `thinking` apply when a session is created; a resumed session keeps its own. The prompt, tools and flags are re-applied on every respawn (the profile is saved per session in `~/.local/share/ronpi/session-agents.json`, so editing the file later does not change existing sessions).
