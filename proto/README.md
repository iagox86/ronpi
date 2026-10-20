# ronpi M0 prototype

**Status: working and kill-test verified (2026-10-20), confirmed working in
Ron's real tmux environment.** Daemon-owned pi children survived controller
SIGKILL mid-run (count to 80 completed after the kill); reattach replayed the
full transcript from the session file; streaming markdown renders live;
ctrl+T switches tabs with per-tab transcripts and background streaming
markers; ctrl+C aborts. Untested: permission dialog forwarding end-to-end
(wire format implemented, no dialog fired during tests - pure-chat prompts
don't trigger permissions.ts).

Daemon (`daemon.ts`) + controller (`controller.ts`) proving the core
architecture: pi children owned by a daemon, a dumb TUI controller, and the
kill-the-controller-mid-run property.

Node: v26.12.0 via nvm (`.nvmrc` present; nvm's default alias is v20, which
will NOT run this - type stripping needs 26). Children are spawned with
`node` from PATH, so launch the daemon from a shell where `node` is v26.

## Run

```fish
cd ~/projects/ronpi/proto
npm install                # symlinks the global pi + pi-tui (file: deps)
node daemon.ts             # window/tab 1: spawns 2 pi children, listens on $XDG_RUNTIME_DIR/ronpi.sock
node controller.ts         # window/tab 2: the TUI
```

Children use your normal pi settings (zai/glm, extensions incl.
permissions.ts). Test sessions are real pi session files under the proto
cwd; delete them from ~/.pi/agent/sessions afterwards if they clutter your
picker.

Keys: `ctrl+T` next tab, `ctrl+C` abort focused run (or quit when idle),
`enter` submit, `y`/`n` answer permission confirms, `1-9` answer selects.
`input`/`editor` dialogs are auto-denied in M0.

## The kill-test (the whole point of M0)

1. Start daemon + controller.
2. Focus tab 1, prompt it with something long: "Count from 1 to 40, one
   number per line." (or any long reply).
3. While it streams, `kill -9` the controller process from another terminal.
4. Check `daemon.log` (same dir): tab 1 events keep flowing after the kill.
5. Start `node controller.ts` again: the transcript replays from the session
   file (history sync) and the stream continues live. Nothing aborted.

## Env knobs

- `RONPI_SOCK` - socket path (default `$XDG_RUNTIME_DIR/ronpi.sock`)
- `RONPI_AUTOSPAWN` - children at startup (default 2)
- `RONPI_CWD` - default cwd for spawned children (default: daemon's cwd)
- `RONPI_LOG` - daemon log path (default: `daemon.log` next to daemon.ts)

## Known M0 shortcuts (deliberate)

- Single-controller assumption on the daemon side (no exclusive attach yet).
- No `/new` command, no deactivation, no groups, no budgets.
- History replay is point-in-time: a child streaming exactly at controller
  attach can show a small gap or transient duplicate.
- `input`/`editor` extension dialogs are denied, not interactive.
- Ctrl+C while a permission dialog is pending answers nothing - answer the
  dialog first (child is blocked by design until then).
