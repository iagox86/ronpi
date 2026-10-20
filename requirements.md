# ronpi - requirements

A daemon-backed controller TUI hosting multiple live pi processes, switchable
through a switcher-style UI, with multiple controllers able to attach to the
same running set. "tmux for pi sessions": daemon = tmux server, controllers =
tmux clients, pi children = panes.

## Problem

pi runs one agent runtime per process. Switching sessions (the left-arrow
switcher in stock pi) aborts the in-flight run. Parallel work today means tmux
windows, which loses the integrated switcher/groups/status UX. pi is the daily
driver (model freedom, speed, hackability), so children are pi only; a
claude-agent-sdk adapter is possible later (also JSONL-over-stdio) but is not
a requirement.

## Hard requirements

1. N live pi sessions, all processing concurrently; switching views or
   crashing a controller never aborts a run. The daemon owns child
   lifetimes.
2. Multiple controllers may attach to the daemon and see the same session
   list. Per-child attach is exclusive for input (one controller drives a
   child at a time); browsing transcripts is always allowed.
3. Session states, visually distinct (color) in switcher and status bar:
   - active/processing: child running, stream in flight
   - active/idle: child running, settled
   - inactive: no process; transcript rendered from the session file
   Lazy activation: opening an inactive session shows its transcript without
   spawning; the child spawns on the first prompt. Deactivation (manual or
   cap-triggered) kills the process, leaving the session reloadable.
4. Switcher modeled on the session-groups extension's UX, NOT tabs: pressing
   left on an empty editor opens a vertical overlay (the "switcher") listing sessions
   with names and groups; up/down selects, enter or right enters, esc
   closes. Live sessions (from the daemon) and inactive sessions (from
   session files, lazily spawnable) appear in the same list under group
   headers; state is shown with color/markers. There is no permanent tab
   bar; the status line identifies the current session and carries ambient
   indicators (running/waiting-permission counts).
4b. Hotkeys are ctrl-based and live in the switcher, acting on the
   HIGHLIGHTED entry - the session view itself has no management chords;
   its only special key is left-arrow on an empty editor (back to the
   switcher). Switcher keys: up/down navigate, enter or right enter, esc
   close, ctrl-n new session, ctrl-x kill highlighted session, ctrl-r
   rename highlighted, ctrl-g group highlighted. Key decoding must use
   matchesKey/Key (legacy + kitty + csi-u), never raw bytes. ctrl-x
   semantics: deactivate the child (session file stays, lazy respawn on
   next prompt); deleting the session file itself is a stronger,
   separately-confirmed action.
4c. Open question: aborting a running session from the session view -
   currently ctrl-c (abort when streaming, quit when idle), matching pi
   muscle memory; Ron's "only left arrow" instinct may or may not intend
   dropping it. Alternatives: abort action on the switcher entry, or a
   typed command.
5. Permission gating end to end: children run permissions.ts; confirm
   dialogs forward to the driving controller; badge-and-block (no timeout,
   child waits indefinitely); dismissal always means deny.
6. Per-child model/provider choice at spawn.
7. Status bar equivalent to status-bar.ts, rendered controller-side: session
   name, dir, git branch, model, ctx usage, thinking level, cost, provider,
   plus the session state from (3).
8. Sessions are stock pi session files: resumable by plain pi, transcript
   replay reads the documented JSONL format directly.
9. Markdown rendering for assistant messages from day one.
10. Group storage shared with stock pi: reuse session-groups.json semantics,
    relocated to ~/.local/share/ronpi/ (XDG data); the session-groups.ts
    extension is updated to the same path. Assignments keyed by session id;
    null tombstones keep fork-inheritance and explicit-ungroup working.
11. Controller runs inside tmux window 0 (0 = AI client, 1 = terminal,
    2+ = code windows).
12. Controller is a view/switch/prompt surface: no bash, no agent logic of
    its own.
13. Working-directory handling: the controller maintains a current directory
    (initialized from the controller's launch cwd), changeable via command;
    new sessions spawn with it (optional per-spawn override). A running
    child's cwd is fixed (pi session property).
14. Usage and budget tracking, maintained by the daemon (survives controller
    detach/crash): per-session tokens and cost, aggregate across sessions,
    configurable budget thresholds.

## Soft requirements

- Middle-click paste into the editor (fetch primary selection via xclip /
  wl-paste; X11 and Wayland paths differ).
- Copy by highlighting (selection + copy-on-select or OSC 52).
- Solarized color scheme; controller owns its palette.
- Background-tab badges: finished run, waiting-on-permission.
- Queuing input to non-visible tabs.
- Split panes; transcript search.
- Claude adapter (deprioritized: "Claude already works like I want").
- MCP server fronting the daemon (list/spawn/deactivate/query sessions) so
  any pi session can manage the fleet via mcp.json; explicitly not 1.0.
- Optional web GUI for remote control: another client of the daemon socket
  (HTTP/WebSocket bridge). Real cost is exposure (auth, TLS, binding), not
  the UI. Explicitly last tier; likely never.

## Remaining open questions

1. Activation cap: default max concurrent active children before forced
   deactivation? (Configurable; measure memory per child first.)
2. Daemon supervision: does the daemon itself need restart protection
   (systemd user service), or is a manual `ronpid` acceptable given daemon
   crash kills children?
3. Deactivation policy: manual only, or LRU auto-deactivate at the cap?
4. Primary selection source on this machine: X11 or Wayland (affects
   middle-click paste implementation)?
5. Should two controllers be able to watch the same child read-only while a
   third drives it, or is even viewing exclusive in v1?
6. Budget behavior on threshold: warn-only, or refuse new prompts? Over what
   window (daemon lifetime vs persisted daily/weekly rollups under
   ~/.local/share/ronpi/)?
