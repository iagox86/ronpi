# ronpi

A daemon-backed controller that hosts multiple live pi sessions in one
terminal: pick a session with a grouped overlay switcher, keep agents running
in the background, switch between them without aborting anything, and never
lose work to a crashed UI. Think "tmux for pi sessions" - the daemon is the
tmux server, controllers are clients, pi children are panes - except the
rendering is pi's own toolkit, not tmux.

pi (the coding agent) runs one agent runtime per process, and switching
sessions inside a single pi process aborts the in-flight run. ronpi fixes
that by owning the child processes in a daemon: killing or crashing a
controller never touches a running agent.

## Terminology

- **daemon** - owns the pi child processes and all state; controllers come
  and go
- **controller** - a TUI client attached to the daemon (the whole app
  window)
- **switcher** - the overlay where you select, group, rename, and kill
  sessions; left-arrow on an empty editor opens it
- **session** - one conversation: live (has a child process, streaming or
  idle) or inactive (file only, lazily respawned on first prompt)

## Layout

- `requirements.md` - what this must do; hard/soft requirements and open
  questions
- `design.md` - validated pi-integration findings (RPC protocol, pi-tui,
  extension consequences), architecture, M0 findings, milestones
- `proto/` - the M0 prototype: working daemon + controller, kill-test
  verified. See `proto/README.md` to run it.

## Status

M0 prototype complete and verified: daemon-owned pi children survive a
controller SIGKILL mid-run, transcripts replay from real pi session files on
reattach, streaming markdown renders live, tab switching and abort work.
M1 (usable daily driver) is scoped in `requirements.md`: overlay session
switcher with groups, ctrl-based hotkeys, permission-dialog forwarding,
exclusive attach, lazy session activation.

## Requirements

- Node v26.12.0 via nvm (`.nvmrc` in proto/; note the nvm default alias is
  v20, which will not run this - type stripping needs 26)
- pi installed globally under that node version
- pi runs on your normal settings/auth; children are regular pi processes
