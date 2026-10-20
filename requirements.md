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
4. Switcher modeled on Claude Code's agent list (Ron's preference after
   trying alternatives): FULL-SCREEN, a quiet two-column table (name |
   last-activity/description) under dim group headers, selection shown by
   brightness only (no cursor-prefix characters - they make text shift).
   Pressing left on an empty editor opens it; up/down selects, enter or
   right enters, esc or left closes. Live sessions (from the daemon) and
   inactive sessions (from session files, lazily spawnable) appear in the
   same list; state shows via markers and the description column. There is
   no permanent tab bar; the status line identifies the current session and
   carries ambient indicators (running/waiting-permission counts). Display
   order freezes while the switcher is open (recency-sorted at open) so
   background session-file writes elsewhere never reshuffle the list under
   the cursor.
4b. Hotkeys are ctrl-based and live in the switcher, acting on the
   HIGHLIGHTED entry - the session view itself has no management chords;
   its only special key is left-arrow on an empty editor (back to the
   switcher) plus typed slash commands intercepted controller-side:
   /abort (abort the current run - never forwarded to the child),
   /exit and /quit (quit the controller - also never forwarded; exiting
   the child is ctrl-x's job). Typing while a run streams sends the message
   as STEERING (pi streamingBehavior "steer") instead of failing. Switcher
   keys: up/down navigate, enter or right
   enter, esc close, ctrl-n new session, ctrl-x kill highlighted
   session, ctrl-r rename highlighted, ctrl-g group highlighted. The
   switcher also has its own command box offering typed equivalents
   (/new, /kill, /rename <name>, /group <name>, /exit, /help) so every
   hotkey has a command form. Key decoding must use matchesKey/Key
   (legacy + kitty + csi-u), never raw bytes.
4b-i. ctrl-x is context-sensitive: active session -> deactivate (child
   killed, session file stays, lazy respawn on next prompt); inactive
   session -> delete WITH confirmation. Delete is reversible by
   construction: the file moves to ~/.local/share/ronpi/trash/ (never
   unlinked; a /restore command can bring it back), and the orphaned
   group assignment is removed from session-groups.json. pi session
   files are the only copy of a session - there is no registry that
   regenerates them, so unlink would be permanent.
4c. Decided: no ctrl-c anywhere (feels like hard-kill); abort is /abort
   in the session view or an action on the running switcher entry; quit
   is /exit in either view.
5. Permission gating end to end: children run permissions.ts; confirm
   dialogs forward to the driving controller; badge-and-block (no timeout,
   child waits indefinitely); dismissal always means deny.
6. Per-child model/provider choice at spawn.
7. Status bar equivalent to status-bar.ts, rendered controller-side, placed
   BELOW the chat box (matching his status-bar.ts extension layout): session
   name, dir, git branch, model, ctx usage, thinking level, cost, provider,
   plus the session state from (3). (M1 ships name/model/state/counts;
   full parity later.)
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
- Session-view input parity (future): esc briefly pauses input while
  streaming; child TUI slash commands that need interactivity (/model etc)
  mapped to RPC equivalents (set_model/cycle_model, compact, ...);
  autocomplete for /commands in the chat box.
- Manual switcher ordering (IMPLEMENTED in M1; session-groups.json carries
  an `order` array of session UUIDs that both writers preserve):
  - shift+up/down on a session row moves it one display row; crossing a
    group header moves it between groups (assignment persists; moving into
    (ungrouped) sets the explicit-ungroup tombstone)
  - new sessions sort to the bottom of their section; sessions not present
    in `order` sort after all ordered ones
  - shift+up/down on a group header reorders the groups themselves
    ((ungrouped) stays first); the groups array order in
    session-groups.json is the persisted group order
  - selection follows the moved item
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
5. DECIDED: viewing is never exclusive - every controller receives every
   event stream; only input attach is exclusive, acquired on enter,
   refused with a hint on conflict, stolen by a second enter.
6. Budget behavior on threshold: warn-only, or refuse new prompts? Over what
   window (daemon lifetime vs persisted daily/weekly rollups under
   ~/.local/share/ronpi/)?
