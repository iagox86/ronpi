# toriel reference

**Status: working and verified (2026-10-20).** Daemon-owned sessions survive
controller restarts; the switcher opens at startup and lists ALL sessions
(live + inactive, grouped); lazy activation spawns a child on first prompt;
deactivate/kill/rename/group/delete all work; permission dialogs route
end-to-end with badge-and-block; two controllers share the list with
exclusive input attach and explicit take-over.

## Run

```fish
cd ~/projects/toriel
npm install                # once; symlinks the global pi + pi-tui
node toriel.ts              # auto-starts the daemon in the background if none is running
node toriel.ts kill-server  # stop the daemon (orderly: children shut down too)
```

The daemon detaches and keeps running when the controller exits; restarting
a controller reattaches to everything. Multiple controllers can run against
one daemon. `kill-server` uses the pidfile next to the socket and refuses to
signal anything that is not the toriel daemon.

## Sessions opened in plain pi

Sessions created outside toriel show up in the switcher like any other
(toriel lists session files, regardless of who wrote them). To make their
liveness visible, load the **toriel-presence** extension into pi (it ships
in your extensions dir): every pi process then heartbeats the daemon, and
the switcher marks those sessions with a `[pi]` prefix and a dimmed name -
even before pi has written the session file (pi creates it lazily), the
live registration itself shows up as a switcher row; the session view shows
a LIVE-IN-PI tag. If that session is deleted elsewhere (e.g. pi's resume
picker) the row is dropped at the next prune tick instead of ghosting until
the heartbeat expires. toriel's OWN children are excluded (they are spawned
with `TORIEL_CHILD=1`, and the daemon also ignores registrations from their
pids), and presence heartbeats do not count as controller connections.

Prompting a pi-owned session asks first: "continuing here FORKS the
conversation (pi keeps its copy)" - enter again to fork it into a new
toriel-owned session (pi-native `--fork`) and deliver the prompt there, esc
to cancel. `/adopt` does the same fork without a prompt. If the session is
open in BOTH toriel (live child) and an external pi, prompting is refused
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

In a session: `ctrl-r` reverse-searches this session's history (type to filter, `ctrl-r` older, `ctrl-s` newer, `enter` use, `esc` cancel); `/` completes toriel's and pi's commands (fetched from the running pi via the daemon), `@`/paths complete files.

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
- `!command` - (the chat box border turns yellow while the text starts with `!`) run a shell command in the session's directory. The daemon runs it itself (`local-command.ts`, bash in its own process group, output merged and cleaned of colour codes, start and end kept past ~24k characters, 10 minute limit) and hands the agent the result at once as an ordinary prompt: a `<local-command-caveat>` saying the user ran it, then `<local-command>cmd</local-command><local-command-output exit="N">...</local-command-output>`. That starts a turn, or queues behind the running one. pi's own `bash` RPC is not used because it only shows the model the output with the user's next message. The transcript recognises the tags (live and on replay) and draws the usual command block; the switcher summary shows `$ cmd`. The first-message display fallback renders a bang-first session as `$ cmd` too, not as the wrapper text. `esc` stops it (`abort_bash`); one command at a time per session; refused while compacting. `!!` is not offered. Code: `SessionActions.bang`, daemon `handleBash`/`handleAbortBash`, `userItem` in `transcript.ts`.
- Viewing a subagent: an accent-coloured editor border, a banner line above it ("SUBAGENT of X - /parent jumps to the parent") and `SUBAGENT of X` in the status line; the status line also shows `+$ children` for what the sessions below it have spent. `/parent` opens the parent; `/detach` (here or on the highlighted row in the switcher) removes the link both ways. The session is top-level again, and on its next start it is no longer told who its parent was.
- `ctrl-o` - expand/collapse tool runs (collapsed: one summary line per run, "5 tool calls: bash x2, read, grep, +2 more" - the first three tool names, then a count)
- `ctrl-t` - show/hide thinking (starts from pi's `hideThinkingBlock`)
- mouse wheel scrolls (speed from pi's `fullscreenWheelScrollLines`); the
  view stays where you scrolled while output arrives
- `left` on empty editor - open the switcher
- toriel's own commands (declared in `commands.ts`, intercepted here, never sent to pi):
  `/abort`, `/quit` (back to the switcher), `/exit` (quit the controller; child exit
  is ctrl-x's job), `/name <name>` or `/rename <name>`, `/model [-l] [words]` (no
  argument: an interactive picker - up/down, type to filter, enter; `-l` just lists them; otherwise switches to the one model
  whose `provider/id` contains all the words), `/think [level]` (no argument: a notice with the current
  thinking level and every level the session's model supports, tab completes them; otherwise switches to the one level
  the argument matches - an unambiguous prefix works, several matches or an unsupported one are an error; levels come
  from pi over RPC, so models without thinking just offer `off`, `/compact [focus]`, `/init` (asks the agent to write or update the project's `AGENTS.md`, folding in `CLAUDE.md` and other standard agent-instruction files), `/mcp [list|status|explore|add|remove|reconnect|login|logout] [server]` (pi has no connect/disconnect: `list` shows every server on one line: its state plus `skill: <name>` when a skill directory in the pi agent dir's `skills/` is named after it (the directory name must contain the server name; matches are case-insensitive and never fall back to a SKILL.md's body text), or `no matching skill (/mcp explore <server>)` when none does; `add <name> <url | command args...>` writes the server into pi's `mcp.json` (never replacing one) and reloads the session; `remove <server>` takes it out of pi's user `mcp.json` (a server defined in the project's `.pi/mcp.json` or by an extension is named but not touched) and reloads; `status [server]` is for troubleshooting (`mcp-doctor.ts`): per server, pi's state and error text, where and how it is configured (env/header values and token-like arguments hidden), local checks (command on the PATH, URL host:port accepting connections - only for servers that are not connected, or the one named) and what to try; `explore <server>` asks this session's agent to introspect that server (every tool with its full parameter schema, resources) and write a pi-format skill for it under the pi agent dir's `skills/` (updates one if it already exists; refused with a notice when the server is not a configured mcp.json server or not connected, in which case it suggests `/mcp reconnect`); the others are pi's own, and tab after an action completes server names with their state), `/clear` (wipe the conversation in place - same session, name and model; old contents go to trash), `/reload`
  (restarts pi on the same file so new extensions, skills and settings load) and
  `/fork [-n name] [prompt]` (continue in a copy, entered immediately; the original is untouched. The copy is named `⑂ <original name>`, listed right below it in its group, and optionally gets `prompt` as its first message. The copy is told its parent - id, name, file - via an appended system prompt; lineage is recorded both ways in `lineage.json` next to the groups file, but the parent is not told about its forks yet: see design.md, parent/child communication)
- typing while the agent streams sends the message as steering (never fails
  with "already processing")
- everything else goes to the child, slash commands included

Switcher (full-screen, solarized-dark, Claude-Code-agent-list style: a
quiet table of name | age | model | summary under dim group headers, the
name column always fully expanded, selection shown by brightness only;
header carries aggregate token/cost rollups tracked by the daemon; "age"
is time since the session file was last written - pi appends on every
request/response). Row marker: an animated spinner while streaming, `c`
while compacting, `·` idle, `-` inactive, `x` crashed; a compacting row's
summary column says `compacting`:
- `up`/`down` select, `enter`/`right` open, `esc` cancels a typed command
  (no-op otherwise), `left` no-op
- `left`/`right`/`enter` on a group header fold/unfold it (`left` folds, `right` unfolds, `enter` toggles; remembered across runs; dragging a session into a folded group unfolds it): a folded group shows `▸`, hides its sessions and gives a one-line summary (count, working/idle, newest age); a filter unfolds everything while it is on
- Sessions an agent started (subagents) hang under their parent; copies you make yourself with `/fork` or `/adopt` do not (they stay recorded in `lineage.json`, but are ordinary sessions): indented with `└`, in the parent's group, and the parent row says `N children, M working, K parked`. `left` on an open parent folds its children (`▸`), `right` on a folded one unfolds it, `left` on a child jumps to its parent; folds are remembered with the group folds. `shift+up`/`down` on a parent moves it with everything below it (a child cannot be moved alone). `/park` on a child hides it under its parent (`/filter` shows it again); deleting a parent leaves its children listed on their own. The tree comes from `lineage.json` (`session-tree.ts` builds it).
- `shift+up`/`shift+down` move the highlighted session or group (crossing a
  header moves the session between groups; persisted to groups.json)
- `ctrl-n` new session (controller's cwd), `ctrl-k` stop the highlighted
  session's process (file kept), `ctrl-x` delete it (press twice; moves to
  trash, stopping it first if running; on an empty group header: delete the
  group), `ctrl-r` or `f2` rename (prefilled with the current name),
  `ctrl-g` group, `ctrl-f` filter the list as you type (up/down move, enter keeps the filter; esc clears it, here or later)
- typing plain text (not starting with `/`) and pressing enter starts a new
  session with that as its first message
- `/` completes commands (popup, tab); the list comes from `commands.ts`, so
  new commands appear automatically
- the bottom chat box doubles as the switcher command line: `/new [-n name] [-C dir] [-a agent]` (start as an agent profile) `/agents` `/stop` `/delete [-y]` `/park [-u]` (session name and age are coloured by recency - bold white under a day, light grey under 3 days, grey under a week, then dark grey; `/park` forces the muted colour until the session is used again, `-u` clears it; inside a session `/park` also stops it (if idle) and goes back to the list) `/ungroup` `/comment [-c] [text]` (a hidden note per session, stored by UUID in `session-groups.json` `comments`, searched by the filter, never pruned) `/filter [-r] [words]` (show only matching sessions - name, summary, group, model, directory or comment, all words must match; `-r` takes one regex; no text clears)
  `/rename <name>` `/group <name>` `/adopt` `/kill-daemon` `/quit` `/exit`
  `/help` `/summarize` `/restore [words]` (pick a deleted session from the trash to bring back,
  with its group and summary; a single match is restored directly)
- display order freezes while the switcher is open, so background file
  activity never reshuffles the list under the cursor; manual positions
  (order array) always win
- stop (`ctrl-k`, `/stop`) deactivates a live session: the child stops, the file
  stays, and it respawns on the first prompt. delete (`ctrl-x`, `/delete`) is
  always arm-then-confirm: press twice to move the session to trash (a running
  one is stopped first); the cursor stays put on the entry after the deleted
  one; a never-prompted session has no file, so deleting one just drops it
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
  `$XDG_DATA_HOME/toriel/trash/` with a `.json` manifest (original path +
  timestamp), because the session file is the only copy that exists.
  Groups live in `$XDG_DATA_HOME/toriel/session-groups.json`, shared with
  the stock pi session-groups extension (legacy `~/.pi/agent` path still
  read as fallback).
- Permission dialogs: children running permissions.ts block on ask-listed
  commands; the dialog routes to the attached controller (y/n, digits for
  select, esc cancels select). The dialog is labeled with the session that
  raised it (e.g. "Session 3 'Worker'", id alone when unnamed) in its title
  and the status-line hint. Unattached or unanswered dialogs keep the
  child blocked, and a fresh controller sees the pending dialog (badge `!`,
  re-sent on attach). No timeout anywhere.
- Transcript replay renders tool calls/results from the session file,
  matching the live view (args matched from toolCall blocks).
- Known gaps: `/restore` not built; `input`/`editor` dialogs auto-deny;
  a ctrl-chord in the first second after start can be swallowed by pi-tui's
  keyboard negotiation.

## Settings

`~/.config/toriel/settings.json` (`$XDG_CONFIG_HOME`, or `TORIEL_SETTINGS` for
a different path). All keys optional: `steeringMode` (`"all"`, the default, or
`"one-at-a-time"`), `provider`, `model`, `thinking`, `piCli`. Layers: built-in
defaults, then this file, then the `TORIEL_*` environment variables below. The
daemon re-reads the file every time it starts a child, so edits apply to new
and respawned sessions without a restart; running sessions keep the values
they started with, and the switcher status line says how many are behind
(by file mtime). Bad values are ignored and reported there too.

## Messages between sessions

`toriel_message({to, text})` (pi extension `pi/extensions/toriel-agents.ts`, children only) asks the daemon (`message` command, `daemon-handlers-messages.ts`) to deliver `text` to `to`: a UUID, UUID prefix, `#number` or name (`daemon-resolve.ts` finds it, in the daemon's sessions first, then session files on disk). The target gets a message `[from NAME (uuid)]: text` (`received.ts`); an inactive session is started for it; a compacting one holds it with the other held messages. When the target has the session bridge extension connected (`daemon-handlers-bridge.ts`), the daemon hands the message to the bridge (`bridge_inject`) and the extension delivers it as a `toriel-inject` custom message at a turn/settle boundary or immediately when idle - confirmed by the append, never pi's steering queue; otherwise it is queued as legacy steering (`deliverToSession`, which warns once when the bridge is missing). Delivering does not take the target's input attach. Refused: unknown or ambiguous target, itself, a session open in another pi process, empty text. The caller gets "delivered", not a reply; a reply is a message the other way. Received messages are shown as "from NAME" and are not offered as rewind points.

## Side questions and mouse clicks

`/btw` (`btw.ts`) copies the session file to a temp dir and runs `pi --print --session <copy> --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files [--model m] <prompt>`; the prompt (`btwPrompt`) says there are no tools and nobody to answer follow-ups. The copy is deleted afterwards, so the session file is never touched and a sleeping session stays asleep. The answer goes to the `InfoPanel` with actions (`PanelAction`: `c` copies via `Host.copyText`, `s` writes `btw-<time>.md` under `$XDG_DATA_HOME/toriel/btw/`). Not verified against a real model with tool-call history and `--no-tools` (some providers may reject tool calls without tool definitions; the error is shown).

pi-tui turns a press and release on one cell into a `click` that pi's thinking blocks and tool output toggle on. `click-guard.ts` wraps the screen's private `dispatchMouseToLayout` so only `clickCount >= 2` clicks reach the transcript (`TORIEL_CLICK=single` disables the guard). Presses, drags, the wheel and text selection are untouched.

## Dialogs that go stale

A permission dialog is held by the daemon (`pendingDialog`, `lastDialog`) until answered. It is also dropped when the turn settles (`agent_settled`) and when the dialog's `timeout` passes (pi resolves such a dialog itself and says nothing). The controller drops its open dialog when the session list says none is pending, asks the daemon again (`attach`, which resends the waiting dialog) when the list says one is pending for us and none is open, shows and answers a dialog only while its session is on screen (with the switcher up the dialog stays pending, the row says "waiting on permission", and entering the session shows it again), and keeps an open dialog when the history reply replaces the view (the daemon sends the dialog just before the history).

## Waking sleeping sessions

A session that was stopped, or not started since toriel restarted, has no pi process. Commands that need one (`/model`, `/compact`, `/clear`, `/mcp list`, `/mcp explore`, `/reload`, `!command`) start it themselves through `SessionCommands.liveMeta()`; no message is needed. Commands that do not (`/name`, `/park`, `/comment`, `/btw`, `/fork`, `/parent`, `/detach`, `/why`, `/feedback`, `/abort`) leave it asleep, and ones that send a prompt (`/init`, `/mcp reconnect`) wake it through the ordinary prompt path. The wake is per command, not a framework flag, because most commands should not start a process; the rule for new commands is in AGENTS.md.

## Session ids and names

A session's address is its UUID (pi's session id). toriel picks it before pi starts (`--session-id`) for new sessions and reads it from the file for resumed ones, and tells the child as `TORIEL_SESSION_ID` in its environment (not set for a fork, whose id pi chooses; an extension can ask pi). The daemon command `resolve` turns a UUID, UUID prefix, `#number` or name into a session, falling back to the files on disk when the daemon does not hold it. Names are made unique when you set them (`/rename`, `/new -n`, `/fork`): a taken name gets ` #2`, ` #3`; names that pi or another program wrote can still collide, and `resolve` then reports the match as ambiguous.

## Env

- `TORIEL_SOCK` - socket path (default `$XDG_RUNTIME_DIR/toriel.sock`; the
  pidfile lives next to it as `toriel.sock.pid`)
- `TORIEL_PI_CLI` - pi cli.js the daemon spawns as children (tests point this at the fake pi)
- `TORIEL_LOG` - daemon log (default `daemon.log` next to daemon.ts)
- `TORIEL_TRASH` - trash dir (default `$XDG_DATA_HOME/toriel/trash`)
- `TORIEL_PROVIDER` / `TORIEL_MODEL` / `TORIEL_THINKING` / `TORIEL_STEERING_MODE` -
  override the settings file: provider, model and
  thinking level for spawned
  children (e.g. `TORIEL_PROVIDER=litellm TORIEL_MODEL=gemma4:12b` for free
  local tests, or `TORIEL_MODEL=glm-4.7 TORIEL_THINKING=low` for cheap test
  fleets); unset = your normal pi settings
- `PI_CODING_AGENT_DIR` - pass to BOTH processes in tests to isolate
  sessions/settings/extensions from your real agent dir

## Code layout

Source files are in `src/` (names below are relative to it); tests in `test/`; the entry point is `toriel.ts` at the repo root.

Pasting and selecting (Linux; `wl-clipboard` on Wayland, `xclip` on X11):
- `ctrl-v` pastes the clipboard: its text, or - when it holds only an image - an
  `[image #1 png 340 KB]` marker in the chat box; the picture is sent with the
  message (delete the marker to drop it). Refused with a message when the model
  takes no images, or the image is over 8 MB. Not shown in the transcript yet.
- Middle click pastes the primary selection (whatever you last highlighted).
- Text selected inside toriel is copied to both the clipboard and the primary
  selection, so either paste finds it. Shift+click still hands the mouse to the
  terminal.
- `/mouse [on|off|toggle]` (session view and switcher; no argument shows the state; `/mouse --help` describes it): `off` stops toriel's mouse reporting, so the terminal does select, copy and middle-click paste itself - also over SSH, where toriel cannot read your clipboard. While off, toriel's clicks (switcher rows, double-click on blocks) and its own selection highlight stop, wheel scrolling may stop depending on the terminal, and the terminal selects raw screen cells; the status line shows `mouse off` in a session. Not remembered across restarts. Shift held during one click does the same for that click only.
- **Over SSH or without a display** there is no clipboard tool to run (`WAYLAND_DISPLAY` and `DISPLAY` are unset on the remote), so selected text is copied through the terminal with OSC 52 escapes (`osc52.ts`), one for the clipboard (ctrl-v) and one for the primary selection (middle click). The terminal never says whether it accepted it, so the flash reads "Sent to the terminal clipboard (not confirmed)" rather than "Copied!". Your terminal must allow it: kitty and most others allow OSC 52 *writes* by default (kitty's `clipboard_control`, `write-clipboard write-primary`); *reads* (what ctrl-v over SSH would need) are off by default and toriel does not do them yet.
- **Inside tmux** the escape needs one of these in `~/.tmux.conf` (restart tmux or `tmux source-file`): `set -g set-clipboard on` (tmux handles the escape itself) or `set -g allow-passthrough on` (tmux 3.3+; tmux forwards it). toriel sends both forms under `$TMUX`, so either setting works; with neither the copy is dropped silently, which is why the flash says "not confirmed" and names both.
- **Paste over SSH:** ctrl-v and middle-click would read the *remote* machine's clipboard, which does not exist there, so toriel says so in the notice line ("over ssh there is no local clipboard to read...") instead of failing quietly. Use your terminal's own paste key: ctrl-shift-v for the clipboard, shift-middle-click for the primary selection (toriel has the mouse; shift hands it to the terminal). Both arrive as an ordinary bracketed paste.
- Copies were once slow to reach the primary selection (about 4s per target): `wl-copy` and `xclip` leave a background process that serves the selection and inherits their output pipes, so waiting for the pipes (`execFile`) took the whole tool timeout. Writes now finish when the tool exits (`runWrite` in `clipboard.ts`).
- Not covered here (data not yet written up): primary-selection quirks per terminal. The open ticket for reading the local clipboard over SSH via the OSC 52 query is separate.
- Code: `clipboard.ts` (the tools), `clipboard-terminal.ts` (takes the middle
  click out of the input before pi-tui's mouse handling), `attachments.ts`.

Daemon side:
- `daemon.ts` - entry point: wires the pieces below together, owns startup, polling and shutdown
- `daemon-session.ts` (session record + registry), `daemon-hub.ts` (connected controllers, fan-out),
  `daemon-children.ts` (starting/stopping pi children, their events), `daemon-meta.ts` (session list per
  controller), `daemon-history.ts` (what a controller shows for a session)
- `daemon-server.ts` (socket server), `daemon-dispatch.ts` (command -> handler), `daemon-handlers-lifecycle.ts`
  (prompt, spawn, adopt, attach, delete, rename), `daemon-handlers-ops.ts` (model, compact, reload, clear,
  rewind, dialogs); handlers get a `DaemonContext` (`daemon-context.ts`) - no module-level mutable state
- `presence.ts` - sessions open in external pi processes (heartbeat/pid/ghost pruning)
- `agents.ts` (agent profile files: parse, load, launch arguments), `session-agents.ts` (profile saved per session), `agents-completion.ts` (`/new -a` completion, `/agents` panel); the shipped profiles are in `../agents/`, see `agents/README.md`
- `local-command.ts` (`!command`: run it, clean/trim the output, the tagged message the agent receives and its parser)
- `received.ts` (label on messages between sessions), `daemon-handlers-messages.ts` / `daemon-resolve.ts` (deliver / find a session), `daemon-bridge.ts` + `daemon-handlers-bridge.ts` (session bridge: inject tracking, routing, confirmation)
- `mouse.ts` (/mouse: the reporting on/off codes and the argument parsing)
- `osc52.ts` (copy through the terminal, tmux passthrough wrapping)
- `resync.ts` (what a view keeps when history is replayed; a replay after a reconnect keeps nothing transient), `drift.ts` (message counts and the digest check), `required.ts` (the toriel pi resources that must be linked, the `--tools +name` modifiers for their tools, the startup audit)
- `mcp.ts` / `mcp-doctor.ts` / `mcp-explore-prompt.ts` - /mcp: parse pi's status, add/remove servers, the /mcp status troubleshooting report, the merged one-line /mcp list rendering (state plus skill presence) and the /mcp explore prompt
- `btw.ts` - /btw: ask a throwaway copy of the session one question; `click-guard.ts` - only double clicks reach the transcript
- `session-tree.ts` - parent/child rows: nesting, folding, hiding parked children, the banner and cost rollup helpers
- `session-id.ts` - addressing and naming: `resolveSession` (UUID, UUID prefix of 8+ characters, `#number`, or name, in that order; several matches are reported as ambiguous), `uniqueName` (` #2` suffixes)
- `trash.ts` - delete-to-trash with manifest; `rewind.ts` - cut a session file back to before a user message (tail to trash)
- `settings.ts` - toriel settings file, layered with `TORIEL_*` env, re-read at every child spawn
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
- `pi-settings.ts` - the few pi settings.json options toriel honors (wheel speed, hide thinking)
- `lifecycle.ts` - find/start/stop the daemon, `pi-theme.ts` - pi theme init

Shared: `shared.ts` (wire protocol, LF framing), `groups.ts` (session-groups.json),
`theme.ts` (all colors, read from `../pi/themes/solarized-dark.json`).

Repo root: `pi/` holds the pi-side resources toriel owns (presence extension, theme);
`node src/install.ts` symlinks them into `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`).
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
  Daemon tests set `TORIEL_PI_CLI` to point the daemon at the stub.
- `test/smoke-client.mjs` - manual: connect to a running daemon, prompt, wait for settle.
- Controller UI smoke (manual): run `node toriel.ts` in a detached tmux session with an
  isolated `TORIEL_SOCK` (keep the path short: unix sockets cap at 107 bytes), `TORIEL_LOG`,
  `TORIEL_PI_CLI=test/fixtures/fake-pi.mjs`, `XDG_DATA_HOME`, `PI_CODING_AGENT_DIR`, then drive it
  with `tmux send-keys` / `capture-pane`.

## Command syntax

toriel's own /commands (the switcher box and in-session) parse like a Linux CLI,
using [commander](https://github.com/tj/commander.js): `/fork --name "my fork"
focus on file B`. Every command has `-h` / `--help` (shown in a dismissable
panel). Multi-word values are quoted (`"two words"`, `'two words'`) or have
their spaces escaped (`two\ words`); put `--` before text that starts with a
dash (`/fork -- "-10 is the temperature today"`). Chat-friendly leniencies: a
quote only opens a group at the start of a word (so `You're` is fine), and a
backslash before an ordinary character stays as typed. Lines starting with `/`
whose name is not toriel's go to pi untouched.

Adding a command: add an entry to `SESSION_COMMANDS` or `SWITCHER_COMMANDS` in
`commands.ts` (name, description, and a `build` that declares options and
arguments on the commander `Command`), then add its handler to the handler
table in `session-commands.ts` / `switcher-actions.ts` - the compiler rejects a
table with a missing entry. Parsing, help text, error messages and the
autocomplete hint all come from the declaration. A command whose argument has a
fixed set of choices (`/model`, `/group`, `/mcp`) can also give a `complete` function
(see `CommandSpec` in `cli.ts`): typing the command and a space then pops up the
choices, narrowed by what is typed. Flags are not completed.

## Summaries

`/summarize` (switcher) writes a one-line summary of the highlighted session
into the Summary column, using a model run through pi's print mode:
`-m provider/id` (default: `summaryModel` in `~/.config/toriel/settings.json`,
else `litellm/gemma4:12b`), `-c <chars>` (transcript size, default 2500), `--all`
(every session with no summary or a stale one). Summaries live in
`session-groups.json`. They are kept up automatically: every
`summaryIntervalMinutes` (default 60, `0` turns it off) while toriel is open, it
summarizes sessions that have no summary yet or have gained at least
`summaryMinNewMessages` (default 6) messages since theirs, skipping any that
are running or were written to in the last 3 minutes. Most recently touched
sessions go first, at most 10 per pass, so a backlog of old sessions fills in
over several passes. Failures are logged and retried next pass.

## Feedback

`/feedback [-c category] <text>` (in a session or the switcher) records a note
about a harness or extension problem; `/feedback -l` lists the recent ones. Notes
go to `$XDG_DATA_HOME/toriel/feedback.jsonl` (`TORIEL_FEEDBACK` overrides), one JSON
object per line, so they can be investigated later by a person or an agent. Each
carries `source` (`user`, or `agent` for a future agent-facing tool), the session
file, pi's session uuid, model and provider, and the newest entry at that moment:
`session.entryLine` is its 1-based line in `session.file` and `session.entryId`
its `id`, so `sed -n '<entryLine>p' <file>` shows the turn. `at` (UTC) lines up
with `env.daemonLog`, and `env` has the toriel revision and pi version.

## Status bar and compaction

The bar under the chat box shows, for the session on screen: name | model
(upstream provider) | state (idle, or what it is doing) | ctx used/max and
percent | thinking level | cost. Gauges (model tier, context fill, effort) run
smoothly from green at 0% to red at 100% in the theme's palette; when the
terminal is narrow the least important segments drop first (thinking level,
model, cost, context), never the name or state. Context and cost come from pi's
own session stats, so they survive a daemon restart; context is unknown (`?`)
right after a compaction until the model's next reply.

Messages sent while a `/compact` is running are held by the daemon (pi itself
refuses prompts then), shown as queued, and delivered in order when it finishes.

Steering into a busy session (a typed prompt or a session-to-session message)
queues in pi and shows on the same strip. Pi's queue updates are the only source
of that state, so whenever the daemon refreshes a child's state it also checks
pi's pending-message count: if pi has nothing queued, it re-announces an empty
queue, so a strip can no longer stick on stale entries after a lost update.

When a session has the session bridge extension (`pi/extensions/toriel-session-bridge.ts`, which adds the command `/toriel-inject`), messages from other sessions skip pi's steering queue entirely: the daemon sends the command over the child's own pipe with an id, and the extension delivers them as `toriel-inject` custom messages - at the next turn boundary mid-run (pi announces these as `entry_appended`), at the settle boundary at the end of a run, or by starting a turn when idle (`message_end`). The daemon confirms each from that announcement, so a lost event cannot strand the message or its strip entry; the strip shows what the bridge still holds. Anything handed to pi that never reached the transcript is put back and sent again; a refused or failed inject falls back to steering; a session that stops with unconfirmed injects says so (`exited` with a reason). Only messages from other sessions take this route, not your own prompts. A session without the bridge (extension not linked: `node src/install.ts`, then restart the session) falls back to steering, is marked `sessionBridge: false`, and the switcher notice line counts such sessions. Design notes: docs/design.md, "Session bridge".

A compaction shows as pi's own summary row ("Compacted from N tokens", ctrl-o
expands it). Pi keeps the whole file, so when a session is replayed from its
file the messages the model no longer has (before the first kept entry) are
shown faint above that row. The rewind list marks messages from before a
compaction and warns that rewinding there also undoes the compaction.

## Usage in the status bar

Quota windows (z.ai's 5h / weekly) and LiteLLM budget spend show after the
context figure, e.g. `5h 16% 7d 4%`, colored green to red. They come from a pi
extension, so toriel never handles your API keys: link it once with
`node src/install.ts` (it also links `toriel-presence`; it refuses to replace a plain file, so remove an older copy of `~/.pi/agent/extensions/toriel-presence.ts` first), then restart toriel. It runs
only in children toriel starts, asks pi's own model registry for the key, makes
one request per minute at most, and reports percentages only. To check what
z.ai returns for your key by hand (this sends the key to z.ai's own host):

    curl -s -H "Authorization: Bearer $(jq -r '."zai-coding-cn".key' ~/.pi/agent/auth.json)" \
      https://open.bigmodel.cn/api/monitor/usage/quota/limit | jq .

Providers without an adapter (ollama, plain OpenAI-compatible hosts) show
nothing. See design.md (in this folder) for the adapters, their sources and what is unverified.

## Reconnect, resync and drift

- **Daemon connection lost.** The controller no longer exits. It keeps the screen and the editor text (nothing typed is sent or dropped), shows "daemon connection lost - reconnecting" in the notice line, and retries with backoff (0.5s doubling to 5s, 20 tries; each try starts a daemon if none is running). On reconnect the daemon's initial sync replays every live session's history; each view is then replaced outright, so activity, queue strip, dialogs and unechoed prompts from before the loss are dropped. After the tries run out it exits as before. Requests in flight fail with "daemon connection lost".
- **Drift check.** When a run settles the daemon broadcasts `digest {session, messages, streaming}`, the number of messages a history replay would hold. A controller counts the messages it has seen (the replay's length plus `message_end` / appended custom entries since); if a settled session's counts differ it sends `resync {session}` and the daemon replays that session's history to it alone. A false alarm (a `!command` result, which has no message event) costs one replay.
- **Tools after /reload.** Every child without a profile tool list is started with `--tools +toriel_message,+toriel_usage` (from `required.ts`), so a resume, which restores the tool list recorded in the transcript, still declares the tools of extensions installed since. A profile that lists tools owns its loadout.
- **Required resources audit.** At daemon start (log) and on the controller's 10-second refresh (notice line) the pi agent dir is checked for the extensions and skill in `required.ts`; anything missing or a dangling link is named with the fix (`node src/install.ts`, restart affected sessions). It never links anything itself.
- **Prompting a sleeping session (#58).** The first prompt starts the session's child, which takes seconds. The controller allows one such prompt per session file at a time: a repeated enter with the same text is ignored with a notice (its echo is kept), different text typed meanwhile is put back in the editor. The daemon's "changed N seconds ago - may be open in another pi" confirmation is skipped for files toriel itself has run a child on (`handled-files.ts`, persisted in `handled-files.json` under the toriel data dir), so a daemon restart does not ask about toriel's own sessions.
