# AGENTS.md

toriel is a daemon plus a terminal controller that host several pi (coding
agent) sessions at once. The daemon (`src/daemon.ts`) owns the pi child
processes; the controller (`src/controller.ts`, started via `toriel.ts`) is a
pi-tui app that talks to it over a unix socket. User docs: `README.md`.
Everything else (keys, env, code layout, design, backlog): `docs/`.

## Job board

Work is tracked on the Vikunja board (projects "Toriel - base" and
"Toriel - Subagents"), not in this repo's issues. When assigned a ticket: work it
per this file, then leave the task open with the `needs verification` label and
a `Done (agent, <date>)` comment with validation steps - only Ron marks tasks
done. Full workflow: the `toriel-job-board-workflow` skill; API details: the
`vikunja-mcp` skill.

## Commands

Use node v26 (`~/.nvm/versions/node/v26.12.0/bin`); the default node is too old.

- `npm test` - all tests, no network or model
- `npm run typecheck` - tsc (node strips types at runtime and never checks them)
- `npm run lint` - biome, lint only (the formatter is disabled; formatting is not enforced)

Run all three before calling work done. Restarting the real daemon is fine,
but never kill other live pi sessions.

## Layout

- `src/` TypeScript source, run directly by node (no build step). `daemon-*.ts` is the daemon side; `controller.ts`, `switcher*.ts`, `session-*.ts`, `transcript.ts` the UI. `docs/reference.md` "Code layout" lists every file.
- `test/` node:test files, one per module; `test/daemon.test.ts` and the other integration tests run a real daemon against `test/fixtures/fake-pi.mjs` via the harness in `test/helpers.ts`, which isolates everything in a temp dir (`TORIEL_SOCK`, `TORIEL_LOG`, `TORIEL_TRASH`), so tests never touch real sessions.
- `agents/` - shipped agent profiles (markdown + frontmatter); format in `agents/README.md`.
- `pi/extensions`, `pi/themes`, `pi/skills` - installed into `~/.pi/agent` by `node src/install.ts` (honors `PI_CODING_AGENT_DIR`); these run inside pi, not inside toriel.
- `docs/design.md` - architecture, validated pi findings, parked work. Read the relevant part before changing protocol or lifecycle behavior.

## Conventions

- Node type stripping: no enums, namespaces or constructor parameter properties; use `import type` for types; import with the `.ts` extension.
- 2-space indent, no tabs (see `.editorconfig`). Block statements always (`if (x) { ... }`, never one-line).
- Pure logic goes in small modules with a unit test beside it in `test/`; classes take their collaborators explicitly. No module-level mutable state in the daemon (handlers get a `DaemonContext`).
- A /command is declared once in `src/commands.ts` (name, description, commander `build`, optional `complete`); parsing, `--help` and autocomplete derive from it, and a handler table keyed by name must cover it (tsc enforces that). Give commands likely options, tab completion and help: every option and argument needs a description, and every command a `help:` text (what it does, examples), which `--help` prints after the options; `test/commands.test.ts` fails when one is missing.
- The daemon<->controller protocol is typed in `src/shared.ts` (JSONL over a unix socket, LF-only framing - never readline). `daemon-dispatch.ts` switches exhaustively over `ClientCommand`, so a new message type is a compile error until both ends handle it. Read `docs/design.md` "Protocol gotchas" before changing protocol or lifecycle behavior.
- A session command that needs a running pi child (anything that calls the daemon about the session: model, compact, clear, mcp list, `!command`) must start a sleeping session first with `await this.liveMeta()` in `session-commands.ts` (it returns undefined after telling the user why it could not), never fail with "send a message first". Commands that only read the file, edit toriel's own state, or send a prompt (the prompt path wakes the session itself) do not wake it. State which kind a new command is in its handler's doc comment.
- Prefer explicit error handling; report failures to the user (notice/panel) rather than swallowing them.
- Never print or commit secrets: `~/.pi/agent/models.json` and `auth.json` hold API keys.
- Update `README.md` (user-facing) and `docs/reference.md` (details) when behavior changes; park follow-ups in `docs/design.md`.
