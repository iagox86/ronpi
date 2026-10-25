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
- ronpi's own commands (declared in `commands.ts`, intercepted here, never sent to pi):
  `/abort`, `/quit` (back to the switcher), `/exit` (quit the controller; child exit
  is ctrl-x's job), `/name <name>` or `/rename <name>`, `/model [-l] [words]` (no
  argument: an interactive picker - up/down, type to filter, enter; `-l` just lists them; otherwise switches to the one model
  whose `provider/id` contains all the words), `/compact [focus]`, `/clear` (wipe the conversation in place - same session, name and model; old contents go to trash), `/reload`
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
request/response):
- `up`/`down` select, `enter`/`right` open, `esc` cancels a typed command
  (no-op otherwise), `left` no-op
- `left`/`right`/`enter` on a group header fold/unfold it (`left` folds, `right` unfolds, `enter` toggles; remembered across runs; dragging a session into a folded group unfolds it): a folded group shows `▸`, hides its sessions and gives a one-line summary (count, working/idle, newest age); a filter unfolds everything while it is on
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
- the bottom chat box doubles as the switcher command line: `/new [-n name] [-C dir]` `/stop` `/delete [-y]` `/park [-u]` (session name and age are coloured by recency - bold white under a day, light grey under 3 days, grey under a week, then dark grey; `/park` forces the muted colour until the session is used again, `-u` clears it; inside a session `/park` also stops it (if idle) and goes back to the list) `/ungroup` `/filter [-r] [words]` (show only matching sessions - name, summary, group, model or directory, all words must match; `-r` takes one regex; no text clears)
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
  children (e.g. `RONPI_PROVIDER=litellm RONPI_MODEL=gemma4:12b` for free
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

## Command syntax

ronpi's own /commands (the switcher box and in-session) parse like a Linux CLI,
using [commander](https://github.com/tj/commander.js): `/fork --name "my fork"
focus on file B`. Every command has `-h` / `--help` (shown in a dismissable
panel). Multi-word values are quoted (`"two words"`, `'two words'`) or have
their spaces escaped (`two\ words`); put `--` before text that starts with a
dash (`/fork -- "-10 is the temperature today"`). Chat-friendly leniencies: a
quote only opens a group at the start of a word (so `You're` is fine), and a
backslash before an ordinary character stays as typed. Lines starting with `/`
whose name is not ronpi's go to pi untouched.

Adding a command: add an entry to `SESSION_COMMANDS` or `SWITCHER_COMMANDS` in
`commands.ts` (name, description, and a `build` that declares options and
arguments on the commander `Command`), then add its handler to the handler
table in `session-commands.ts` / `switcher-actions.ts` - the compiler rejects a
table with a missing entry. Parsing, help text, error messages and the
autocomplete hint all come from the declaration. A command whose argument has a
fixed set of choices (`/model`, `/group`) can also give a `complete` function
(see `CommandSpec` in `cli.ts`): typing the command and a space then pops up the
choices, narrowed by what is typed. Flags are not completed.

## Summaries

`/summarize` (switcher) writes a one-line summary of the highlighted session
into the Summary column, using a model run through pi's print mode:
`-m provider/id` (default: `summaryModel` in `~/.config/ronpi/settings.json`,
else `litellm/gemma4:12b`), `-c <chars>` (transcript size, default 2500), `--all`
(every session with no summary or a stale one). Summaries live in
`session-groups.json`. They are kept up automatically: every
`summaryIntervalMinutes` (default 60, `0` turns it off) while ronpi is open, it
summarizes sessions that have no summary yet or have gained at least
`summaryMinNewMessages` (default 6) messages since theirs, skipping any that
are running or were written to in the last 3 minutes. Most recently touched
sessions go first, at most 10 per pass, so a backlog of old sessions fills in
over several passes. Failures are logged and retried next pass.

## Feedback

`/feedback [-c category] <text>` (in a session or the switcher) records a note
about a harness or extension problem; `/feedback -l` lists the recent ones. Notes
go to `$XDG_DATA_HOME/ronpi/feedback.jsonl` (`RONPI_FEEDBACK` overrides), one JSON
object per line, so they can be investigated later by a person or an agent. Each
carries `source` (`user`, or `agent` for a future agent-facing tool), the session
file, pi's session uuid, model and provider, and the newest entry at that moment:
`session.entryLine` is its 1-based line in `session.file` and `session.entryId`
its `id`, so `sed -n '<entryLine>p' <file>` shows the turn. `at` (UTC) lines up
with `env.daemonLog`, and `env` has the ronpi revision and pi version.

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

A compaction shows as pi's own summary row ("Compacted from N tokens", ctrl-o
expands it). Pi keeps the whole file, so when a session is replayed from its
file the messages the model no longer has (before the first kept entry) are
shown faint above that row. The rewind list marks messages from before a
compaction and warns that rewinding there also undoes the compaction.

## Usage in the status bar

Quota windows (z.ai's 5h / weekly) and LiteLLM budget spend show after the
context figure, e.g. `5h 16% 7d 4%`, colored green to red. They come from a pi
extension, so ronpi never handles your API keys: link it once with
`node install.ts` (it also links `ronpi-presence`; it refuses to replace a plain file, so remove an older copy of `~/.pi/agent/extensions/ronpi-presence.ts` first), then restart ronpi. It runs
only in children ronpi starts, asks pi's own model registry for the key, makes
one request per minute at most, and reports percentages only. To check what
z.ai returns for your key by hand (this sends the key to z.ai's own host):

    curl -s -H "Authorization: Bearer $(jq -r '."zai-coding-cn".key' ~/.pi/agent/auth.json)" \
      https://open.bigmodel.cn/api/monitor/usage/quota/limit | jq .

Providers without an adapter (ollama, plain OpenAI-compatible hosts) show
nothing. See design.md for the adapters, their sources and what is unverified.
