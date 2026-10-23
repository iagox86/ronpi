# ronpi M1 prototype

**Status: working and verified (2026-10-20).** Daemon-owned sessions survive
controller restarts; the switcher opens at startup and lists ALL sessions
(live + inactive, grouped); lazy activation spawns a child on first prompt;
deactivate/kill/rename/group/delete all work; permission dialogs route
end-to-end with badge-and-block; two controllers share the list with
exclusive input attach and explicit take-over.

## Run

```fish
cd ~/projects/ronpi/proto
npm install                # once; symlinks the global pi + pi-tui
node controller.ts         # auto-starts the daemon in the background if none is running
node controller.ts kill-server   # stop the daemon (orderly: children shut down too)
```

The daemon detaches and keeps running when the controller exits; restarting
a controller reattaches to everything. Multiple controllers can run against
one daemon. `kill-server` uses the pidfile next to the socket and refuses to
signal anything that is not ronpid.

## Sessions opened in plain pi

Sessions created outside ronpi show up in the switcher like any other
(ronpi lists session files, regardless of who wrote them). To make their
liveness visible, load the **ronpi-presence** extension into pi (it ships
in your extensions dir): every pi process then heartbeats the daemon, and
the switcher marks those sessions with a `[pi]` prefix and a dimmed name -
even before pi has written the session file (pi creates it lazily), the
live registration itself shows up as a switcher row; the session view shows
a LIVE-IN-PI tag. If that session is deleted elsewhere (e.g. pi's resume
picker) the row is dropped at the next prune tick instead of ghosting until
the heartbeat expires. ronpi's OWN children are excluded (they are spawned
with `RONPI_CHILD=1`, and the daemon also ignores registrations from their
pids), and presence heartbeats do not count as controller connections.

Prompting a pi-owned session asks first: "continuing here FORKS the
conversation (pi keeps its copy)" - enter again to fork it into a new
ronpi-owned session (pi-native `--fork`) and deliver the prompt there, esc
to cancel. `/adopt` does the same fork without a prompt. If the session is
open in BOTH ronpi (live child) and an external pi, prompting is refused
("close one before prompting here") - forking cannot help two live
writers. Adopting a session pi has not written to disk yet fails cleanly
("session file not found"); send one prompt in that pi first.

Unnamed sessions (brand-new, or forks still loading) display as
`<unnamed>`; the project directory stays visible in the description
column. For pi processes
without the extension, a file modified within the last 60s triggers a
warn-and-confirm (enter twice) before forking.

Node v26.12.0 via nvm (`.nvmrc`; the nvm default alias v20 will NOT run
this). Children are normal pi processes using your settings/auth/extensions.
The auto-started daemon uses the controller's own node binary, so it works
regardless of PATH.

## Keys

In a session: `ctrl-r` reverse-searches this session's history (type to filter, `ctrl-r` older, `ctrl-s` newer, `enter` use, `esc` cancel); `/` completes ronpi's and pi's commands (fetched from the running pi via the daemon), `@`/paths complete files.

Session view (chat):
- `up`/`down` on the editor - recall earlier input: this session's prompts
  (read from its file, so it survives restarts) and slash commands, in the
  order typed (draft is stashed and restored; cursor movement wins in
  multi-line editors)
- `esc` - abort the running agent; messages still queued come back into the
  editor first (above your draft) so the abort does not deliver them
- `esc esc` on an idle session with an empty editor - rewind: pick an earlier
  message, the session is cut back to before it and the text returns to the
  editor (conversation only, file edits are not undone; the removed part is
  kept in the trash)
- `ctrl-o` - expand/collapse tool runs (collapsed: one summary line per run)
- `ctrl-t` - show/hide thinking (starts from pi's `hideThinkingBlock`)
- mouse wheel scrolls (speed from pi's `fullscreenWheelScrollLines`); the
  view stays where you scrolled while output arrives
- `left` on empty editor - open the switcher
- `/abort` - abort the current run (intercepted here, never sent to the child)
- `/quit` - back to the switcher (intercepted here too)
- `/exit` - quit the controller (also intercepted; child exit is ctrl-x's job)
- typing while the agent streams sends the message as steering (never fails
  with "already processing")
- everything else goes to the child, slash commands included

Switcher (full-screen, solarized-dark, Claude-Code-agent-list style: a
quiet table of name | age | model | summary under dim group headers, the
name column always fully expanded, selection shown by brightness only;
header carries aggregate token/cost rollups tracked by the daemon; "age"
is time since the session file was last written - pi appends on every
request/response):
- `up`/`down` select, `enter`/`right` open, `esc` cancels a typed command
  (no-op otherwise), `left` no-op
- `shift+up`/`shift+down` move the highlighted session or group (crossing a
  header moves the session between groups; persisted to groups.json)
- `ctrl-n` new session (controller's cwd), `ctrl-x` kill highlighted
  (sessions: deactivate; empty groups: delete), `f2` rename (prefilled
  with the current name), `ctrl-g` group, `ctrl-r` search the command history
- typing plain text (not starting with `/`) and pressing enter starts a new
  session with that as its first message
- `/` completes commands (popup, tab); the list comes from `commands.ts`, so
  new commands appear automatically
- the bottom chat box doubles as the switcher command line: `/new` `/kill`
  `/rename <name>` `/group <name>` `/adopt` `/kill-daemon` `/quit` `/exit`
  `/help` (`/restore` later)
- display order freezes while the switcher is open, so background file
  activity never reshuffles the list under the cursor; manual positions
  (order array) always win
- kill is context-sensitive: active session -> deactivate (child stops, file
  stays, respawns on first prompt); inactive/dead -> move to trash, press
  ctrl-x twice to confirm (the cursor stays put: it lands on the entry after
  the deleted one); a never-prompted session has no file - deleting one just
  drops it
- empty groups render as headers and are deletable (ctrl-x on the header);
  stale assignments from trashed sessions are purged so saveGroups cannot
  resurrect the group

## Semantics worth knowing

- Sessions have three states: active/processing, active/idle, inactive
  (file only). A deactivated session's transcript still renders from the
  file; typing a prompt respawns the child with `--session <file>`.
- Input on a live session is exclusive: entering attaches you; another
  controller entering is refused, and a second enter takes over (the old
  driver becomes VIEW-ONLY). Viewing/scrollback is never exclusive - every
  controller receives every event stream.
- Deletes never unlink: the session file moves to
  `$XDG_DATA_HOME/ronpi/trash/` with a `.json` manifest (original path +
  timestamp), because the session file is the only copy that exists.
  Groups live in `$XDG_DATA_HOME/ronpi/session-groups.json`, shared with
  the stock pi session-groups extension (legacy `~/.pi/agent` path still
  read as fallback).
- Permission dialogs: children running permissions.ts block on ask-listed
  commands; the dialog routes to the attached controller (y/n, digits for
  select, esc cancels select). Unattached or unanswered dialogs keep the
  child blocked, and a fresh controller sees the pending dialog (badge `!`,
  re-sent on attach). No timeout anywhere.
- Transcript replay renders tool calls/results from the session file,
  matching the live view (args matched from toolCall blocks).
- Known gaps: `/restore` not built; `input`/`editor` dialogs auto-deny;
  a ctrl-chord in the first second after start can be swallowed by pi-tui's
  keyboard negotiation.

## Settings

`~/.config/ronpi/settings.json` (`$XDG_CONFIG_HOME`, or `RONPI_SETTINGS` for
a different path). All keys optional: `steeringMode` (`"all"`, the default, or
`"one-at-a-time"`), `provider`, `model`, `thinking`, `piCli`. Layers: built-in
defaults, then this file, then the `RONPI_*` environment variables below. The
daemon re-reads the file every time it starts a child, so edits apply to new
and respawned sessions without a restart; running sessions keep the values
they started with, and the switcher status line says how many are behind
(by file mtime). Bad values are ignored and reported there too.

## Env

- `RONPI_SOCK` - socket path (default `$XDG_RUNTIME_DIR/ronpi.sock`; the
  pidfile lives next to it as `ronpi.sock.pid`)
- `RONPI_PI_CLI` - pi cli.js the daemon spawns as children (tests point this at the fake pi)
- `RONPI_LOG` - daemon log (default `daemon.log` next to daemon.ts)
- `RONPI_TRASH` - trash dir (default `$XDG_DATA_HOME/ronpi/trash`)
- `RONPI_PROVIDER` / `RONPI_MODEL` / `RONPI_THINKING` / `RONPI_STEERING_MODE` -
  override the settings file: provider, model and
  thinking level for spawned
  children (e.g. `RONPI_PROVIDER=ollama RONPI_MODEL=gemma4:12b` for free
  local tests, or `RONPI_MODEL=glm-4.7 RONPI_THINKING=low` for cheap test
  fleets); unset = your normal pi settings
- `PI_CODING_AGENT_DIR` - pass to BOTH processes in tests to isolate
  sessions/settings/extensions from your real agent dir

## Code layout

Daemon side:
- `daemon.ts` - sockets, session table, child lifecycle, command dispatch
- `presence.ts` - sessions open in external pi processes (heartbeat/pid/ghost pruning)
- `trash.ts` - delete-to-trash with manifest; `rewind.ts` - cut a session file back to before a user message (tail to trash)
- `settings.ts` - ronpi settings file, layered with `RONPI_*` env, re-read at every child spawn
- `config.ts`, `log.ts` - env-derived paths, daemon log

Controller side:
- `controller.ts` - connection, state, key routing, display toggles; `host.ts` - what the action classes need from it
- `switcher-actions.ts` / `session-actions.ts` - switcher keys and commands / chat-view keys, prompting, rewind, Esc
- `session-list.ts` - pure: daemon sessions + files -> rows, ordering, group moves
- `transcript.ts` - live events and file replays -> pi message components; `tool-run.ts` (collapsible tool runs), `tool-defs.ts` (pi's built-in tool renderers), `components.ts` (user/assistant message tweaks)
- `activity.ts` - working indicator and queued-message strip (events -> state -> lines)
- `rewind-picker.ts` - the esc-esc message list; `history.ts` - slash-command log and history merge
- `status.ts`, `dialogs.ts`, `commands.ts`, `format.ts` - small pure helpers
- `editor.ts` - chat box (key interception, history bindings), `switcher.ts` - the list UI
- `pi-settings.ts` - the few pi settings.json options ronpi honors (wheel speed, hide thinking)
- `lifecycle.ts` - find/start/stop the daemon, `pi-theme.ts` - pi theme init

Shared: `shared.ts` (wire protocol, LF framing), `groups.ts` (session-groups.json),
`theme.ts` (all colors, read from `../pi/themes/solarized-dark.json`).

Repo root: `pi/` holds the pi-side resources ronpi owns (presence extension, theme);
`node install.ts` symlinks them into `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`).
`theme-preview.ts` prints sample components in the active theme.

## Checks

```fish
npm test            # all tests (node:test, no network, no model)
npm run typecheck   # tsc --noEmit (strict; node strips types at runtime, it does not check them)
npm run lint        # biome (lint only; see ../.editorconfig for style: 2-space indent)
```

- Unit tests (`test/*.test.ts`) cover the pure modules.
- `test/daemon.test.ts` runs a real daemon in a temp dir against `test/fixtures/fake-pi.mjs`
  (a stub speaking enough of pi's RPC protocol); `test/helpers.ts` is the harness.
  Daemon tests set `RONPI_PI_CLI` to point the daemon at the stub.
- `test/smoke-client.mjs` - manual: connect to a running daemon, prompt, wait for settle.
- Controller UI smoke (manual): run `node controller.ts` in a detached tmux session with an
  isolated `RONPI_SOCK` (keep the path short: unix sockets cap at 107 bytes), `RONPI_LOG`,
  `RONPI_PI_CLI=test/fixtures/fake-pi.mjs`, `XDG_DATA_HOME`, `PI_CODING_AGENT_DIR`, then drive it
  with `tmux send-keys` / `capture-pane`.
