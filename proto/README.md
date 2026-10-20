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

Node v26.12.0 via nvm (`.nvmrc`; the nvm default alias v20 will NOT run
this). Children are normal pi processes using your settings/auth/extensions.
The auto-started daemon uses the controller's own node binary, so it works
regardless of PATH.

## Keys

Session view (chat):
- `esc` - abort the running agent (interrupt; no-op when idle)
- `left` on empty editor - open the switcher
- `/abort` - abort the current run (intercepted here, never sent to the child)
- `/quit` - back to the switcher (intercepted here too)
- `/exit` - quit the controller (also intercepted; child exit is ctrl-x's job)
- typing while the agent streams sends the message as steering (never fails
  with "already processing")
- everything else goes to the child, slash commands included

Switcher (full-screen, solarized-dark, Claude-Code-agent-list style: a
quiet two-column table of name + last activity under dim group headers,
selection shown by brightness only; header carries aggregate token/cost
rollups tracked by the daemon):
- `up`/`down` select, `enter`/`right` open, `esc`/`left` close
- `shift+up`/`shift+down` move the highlighted session or group (crossing a
  header moves the session between groups; persisted to groups.json)
- `ctrl-n` new session (controller's cwd), `ctrl-x` kill highlighted,
  `ctrl-r` rename, `ctrl-g` group
- the bottom chat box doubles as the switcher command line: `/new` `/kill`
  `/rename <name>` `/group <name>` `/quit` `/exit` `/help` (`/restore`
  later)
- display order freezes while the switcher is open, so background file
  activity never reshuffles the list under the cursor; manual positions
  (order array) always win
- kill is context-sensitive: active session -> deactivate (child stops, file
  stays, respawns on first prompt); inactive/dead -> move to trash, press
  ctrl-x twice to confirm

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
- Known gaps: `/restore` not built; `input`/`editor` dialogs auto-deny;
  a ctrl-chord in the first second after start can be swallowed by pi-tui's
  keyboard negotiation.

## Env

- `RONPI_SOCK` - socket path (default `$XDG_RUNTIME_DIR/ronpi.sock`; the
  pidfile lives next to it as `ronpi.sock.pid`)
- `RONPI_LOG` - daemon log (default `daemon.log` next to daemon.ts)
- `RONPI_TRASH` - trash dir (default `$XDG_DATA_HOME/ronpi/trash`)
- `RONPI_PROVIDER` / `RONPI_MODEL` / `RONPI_THINKING` - provider, model and
  thinking level for spawned
  children (e.g. `RONPI_PROVIDER=ollama RONPI_MODEL=gemma4:12b` for free
  local tests, or `RONPI_MODEL=glm-4.7 RONPI_THINKING=low` for cheap test
  fleets); unset = your normal pi settings
- `PI_CODING_AGENT_DIR` - pass to BOTH processes in tests to isolate
  sessions/settings/extensions from your real agent dir

## Test scripts

- `test/framing.test.ts` - LF-only framing vs U+2028/2029
- `test/smoke-client.mjs` - connect, read tabs, prompt, wait for settle
