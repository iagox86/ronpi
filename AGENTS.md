# AGENTS.md

ronpi is a daemon plus a terminal controller that host several pi (coding
agent) sessions at once. The daemon (`src/daemon.ts`) owns the pi child
processes; the controller (`src/controller.ts`, started via `ronpi.ts`) is a
pi-tui app that talks to it over a unix socket. User docs: `README.md`.
Everything else (keys, env, code layout, design, backlog): `docs/`.

## Commands

Use node v26 (`~/.nvm/versions/node/v26.12.0/bin`); the default node is too old.

- `npm test` - all tests, no network or model
- `npm run typecheck` - tsc (node strips types at runtime and never checks them)
- `npx biome check --write .` - lint (formatting is not enforced by biome)

Run all three before calling work done. Restarting the real daemon is fine,
but never kill other live pi sessions.

## Layout

- `src/` TypeScript source, run directly by node (no build step). `daemon-*.ts` is the daemon side; `controller.ts`, `switcher*.ts`, `session-*.ts`, `transcript.ts` the UI. `docs/reference.md` "Code layout" lists every file.
- `test/` node:test files, one per module; `test/daemon.test.ts` runs a real daemon against `test/fixtures/fake-pi.mjs`.
- `pi/extensions`, `pi/themes` - installed into `~/.pi/agent` by `src/install.ts`; run inside pi, not inside ronpi.
- `docs/design.md` - architecture, validated pi findings, parked work. Read the relevant part before changing protocol or lifecycle behavior.

## Conventions

- Node type stripping: no enums, namespaces or constructor parameter properties; use `import type` for types; import with the `.ts` extension.
- 2-space indent, no tabs (see `.editorconfig`). Block statements always (`if (x) { ... }`, never one-line).
- Pure logic goes in small modules with a unit test beside it in `test/`; classes take their collaborators explicitly. No module-level mutable state in the daemon (handlers get a `DaemonContext`).
- A /command is declared once in `src/commands.ts` (name, description, commander `build`, optional `complete`); parsing, `--help` and autocomplete derive from it, and a handler table keyed by name must cover it (tsc enforces that). Give commands likely options, tab completion and help.
- Prefer explicit error handling; report failures to the user (notice/panel) rather than swallowing them.
- Never print or commit secrets: `~/.pi/agent/models.json` and `auth.json` hold API keys.
- Update `README.md` (user-facing) and `docs/reference.md` (details) when behavior changes; park follow-ups in `docs/design.md`.
