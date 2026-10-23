# ronpi - design notes

## Status

**M1 COMPLETE and verified** (2026-10-20; M0 same day). Code in `proto/`:
daemon.ts (session-centric: states, exclusive attach, trash, lazy spawn),
controller.ts, switcher.ts (overlay UI), groups.ts (shared groups JSON),
shared.ts (protocol v2), test/. See proto/README.md for keys/semantics.
Verified end-to-end in tmux incl. csi-u keys: switcher listing/groups,
ctrl-n/ctrl-x deactivate/ctrl-x-x2 trash confirm, rename, group (shared
file), lazy respawn from file replay, /abort, permission dialog forward +
y-answer with tool actually executing, two-controller exclusivity +
take-over + view-only refusal. pi-side groundwork lives in
~/stuff/dotfiles/server/pi/extensions/.

Findings below were validated against pi's shipped code (pi 1.3.x era).
M0/M1 corrections to earlier assumptions are in "M0 findings".

## Refactor round (2026-10-22)

controller.ts (1700 lines) and daemon.ts were split along existing seams into
pure modules (see proto/README.md "Code layout"), with unit tests for each and
an integration suite that runs the real daemon against a fake pi. Findings:
- `tsc --noEmit` (strict) is now part of the checks: node strips types without
  checking them, which hid dead code (switcher callbacks never declared) and a
  protocol mismatch (controller read `sessionName`, daemon sent `name`).
- Presence invariants: an externally-live session is reported tagged by the
  daemon's FIRST list to a controller, even before pi writes its file; the
  controller hides it until the file is visible locally, so a row can never
  appear without its [pi] tag. Registrations are dropped by pid liveness
  (3s tick), not only by the extension's deregister (lost when pi exits).
- spawn replies as soon as the session is registered; the child starts in the
  background and prompts arriving meanwhile wait on `starting`.
- Not yet split: the Controller class itself (state + key handling + switcher
  actions); the next cut would be switcher actions vs session view.

## NEXT BIG PROJECT: session UX (scoped 2026-10-22)

Roadmap items 7 and 8 combined; goal: ronpi sessions should look and feel
alive. Nothing built yet. Decision (Ron): ONE solarized palette drives both the
session view and the switcher chrome. Keyboard-only: no mouse (reporting would
break terminal select/copy, and click hit-testing against ScrollView offsets is
real work).

Steps, each independently shippable, in order:

1. Theme-loading spike (~10 min, gates everything). pi themes are JSON files;
   `initTheme(themeName)` takes a name, and pi's bundled dark.json/light.json
   (dist/modes/interactive/theme/) list the tokens. Check where initTheme looks
   (probably only ~/.pi/agent/themes/) and whether a path/object can be
   passed; if only that dir, ship the file there or via PI_CODING_AGENT_DIR.
   If neither works, upstream ask (see roadmap #7).
2. Solarized palette: one source file (JSON) -> pi theme (solarized-dark, plus
   light) AND theme.ts (switcher chrome, currently hardcoded 256-color
   approximations) derived from it. Covers markdown, code highlighting, tool
   backgrounds and diff colors, since pi components read the theme. Verify
   edit/write diffs render with a real session: our replay/live paths must pass
   tool args + result `details` to ToolExecutionComponent.
3. Working/thinking indicator (biggest usability win). Spinner line under the
   transcript with a label from the latest event ("thinking", "running
   bash", "writing"), elapsed time, tokens if cheap; spinner glyph on
   streaming rows in the switcher. Needs a ~100ms render timer that runs only
   while the viewed session streams (flicker risk on alt-screen full redraws).
   Check whether pi-tui's Loader is importable, else a ~30-line spinner.
   Events already flow (message_update/thinking deltas, tool_execution_*).
4. Collapse/expand: global `expanded` flag toggled by ctrl-o (pi's own key),
   applied with ToolExecutionComponent.setExpanded on every tool item; a second
   toggle (ctrl-t?) calls AssistantMessageComponent.setHideThinkingBlock
   (currently always hidden). All-or-nothing like pi; per-item expand would
   need a selected-item cursor in the ScrollView - later. Status-line hint.
5. Error rendering: stopReason/message.error as an attention-colored block
   (AssistantMessageComponent may already do this; verify with the fake pi).

Testing: grow test/fixtures/fake-pi.mjs a slow-streaming mode (thinking, tool
events, an error) so the indicator and toggles can be smoke-tested in tmux
without a model. Light variant: let the background be the terminal default.
Risk: Loader/diff components are interactive-mode internals, not all exported
(see the caveat under "Building blocks"); use the shim-module plan there.

## M0 findings (corrections to earlier assumptions)

- **Fullscreen layout is the right model, not main-screen.**
  TuiMainScreen renders children straight into scrollback (no transcript
  viewport; pi's regular mode doesn't use ScrollView at all). The
  ScrollView + VStack flex layout only works on TuiAltScreen via
  setLayoutRoot - mirror pi's createChatViewport
  (dist/modes/interactive/chat-viewport.js): VStack([transcript
  {basis:0,grow:1}, dock{basis:"auto"}]) with the editor at minSize 3.
- **pi's theme instance is NOT exported** from the package index (only the
  Theme class + getMarkdownTheme/getSelectListTheme getters). M0 chrome
  uses raw ANSI (dim/accent helpers); real theming needs an upstream
  export request or theme access via the getters only.
- truncateToWidth, Editor, VStack, ScrollView, TuiAltScreen are pi-tui
  exports; AssistantMessageComponent/UserMessageComponent/
  ToolExecutionComponent/initTheme/getMarkdownTheme are pi exports. Easy
  to mix up; check both indexes.
- Node type stripping is erasable-only: parameter properties
  (`constructor(readonly x)`) throw ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. No
  enums/namespaces either. Run files directly with node v26 (.nvmrc pins
  26.12.0; nvm default alias is v20, which will NOT run this).
- RpcClient: extension_ui_request records fall through to onEvent
  listeners; answer with (client as any).send({type:
  "extension_ui_response", id, ...}) (send is typed-private, present at
  runtime). cliPath defaults to cwd-relative "dist/cli.js" - always pass
  the absolute path. RpcClient spawns `node` from PATH: daemon must be
  launched with v26 first in PATH.
- message_update deltas: text_end/thinking_end carry authoritative
  `content`; replace on end and on message_end.message. toolcall_* deltas
  can be skipped - tools render from tool_execution_* events (args +
  partial results) via ToolExecutionComponent (side-map toolCallId ->
  item; the component doesn't expose its id).
- **Keys must go through matchesKey/Key, never raw bytes.** Through tmux
  extended-keys + csi-u, ctrl+letters arrive as `CSI 116;5u` (codepoint;mods),
  not legacy `\x14`. matchesKey(data, Key.ctrl("t")) decodes legacy, kitty,
  and csi-u uniformly; filter isKeyRelease first. Verified working via
  tmux's own key encoding. Known quirk: a CSI-u ctrl-chord pressed in the
  first moments after start (before kitty/DA1 negotiation settles) can be
  swallowed by pi-tui's keyboard-negotiation reader; presses after ~1s are
  reliable.
- **RpcClient.send() corrupts extension_ui_response**: it overwrites the
  record's id with its own req_N correlation id (dialog replies never
  match) and then waits 30s for an ack the protocol never sends. Dialog
  replies must be written RAW to child stdin. Worth an upstream issue.
- get_state returns model as {provider, id} -> "provider/id" for the
  status line; sessionName falls back to cwd basename.

## Stack

TypeScript on Node.js, effectively fixed by three Node-only imports the
design depends on: pi-tui (Editor/components), RpcClient, and (pending M0
verification) pi's exported markdown/message components. The daemon socket
protocol and session files are plain JSONL, so either half remains
rewritable elsewhere later without touching the other.

## Architecture

```
ronpid (daemon)                                  controllers (N)
  owns child lifetimes                            view/switch/prompt TUIs
  event fan-out to attached controllers   <--->   unix socket, JSONL
  dialog routing (badge-and-block)                built on @earendil-works/pi-tui
  group/state storage (~/.local/share/ronpi/)
   |
   +-- pi --mode rpc child <-> RpcClient (JSONL stdio)
   +-- pi --mode rpc child <-> RpcClient
   +-- (inactive sessions: files only, no process)
```

- Daemon: child lifecycle (spawn on demand, deactivate, respawn), event
  multiplexing, permission-dialog routing to the driving controller,
  exclusive per-child attach bookkeeping.
- Controller renders everything; children render nothing (no TUI in rpc
  mode). Controllers are stateless views: crash one and nothing is lost.
- Daemon crash kills children (accepted; see requirements Q2 for
  supervision options). One process to make reliable instead of N.
- pi-tui is a standalone published package: Editor (multiline, history,
  undo, autocomplete hooks), containers, borders, overlays, mouse events.
- `RpcClient` is exported from the pi package: spawn, id correlation,
  typed commands, event listeners.
- Controller<->daemon protocol: JSONL over a unix socket
  ($XDG_RUNTIME_DIR/ronpi.sock), same framing rules as pi rpc.
- Spawn requests carry cwd; the daemon spawns children with it (RpcClient /
  child_process cwd option). Never rely on inherited cwd - the daemon's
  cwd is meaningless. Session storage is cwd-derived per pi's layout, and
  session listing spans all directories (SessionManager.listAll), so the
  switcher shows sessions from every project regardless of the controller's
  current directory.
- Usage accounting lives in the daemon: message events carry usage
  (input/output/cache/cost); accumulate per-child totals and a global total;
  get_session_stats reconciles on attach. Persist rollups under
  ~/.local/share/ronpi/ if a budget window beyond daemon lifetime is
  wanted. Future MCP server = another client of the same daemon socket
  (list/spawn/deactivate/query), registrable in pi's mcp.json. A future web
  GUI is the same pattern again (bridge client); pi's export_html command
  is a rendering reference for HTML transcripts.

## Session states

- active/processing, active/idle: child exists; agent_settled vs streaming
  events distinguish.
- inactive: file only. Transcript replay parses the session file directly
  (documented JSONL format, session-format.md). Lazy spawn on first prompt.
- Transcript model must accept BOTH live event streams and file replays
  through one renderer, or the two views drift apart. Build the unified
  event-log abstraction first.

## UI paradigm (M1): the switcher, not tabs

M0's tab bar was a placeholder. The shipped UI (after one iteration: the
first overlay was a cramped popup, then a name-grid - Ron picked Claude
Code's agent-list shape) mirrors Claude Code's agent list:

- **Left-arrow on empty editor** opens the session overlay. Interception
  happens in the editor subclass before super.handleInput (same pattern as
  session-groups.ts); left arrives as `\x1b[D`, `\x1bOD`, or kitty/csi-u
  `CSI 1;<mods> D` - reuse the lock-bit-tolerant match, ignoring numlock
  (128) and caps (64) bits.
- **Switcher contents**: group headers from
  ~/.local/share/ronpi/session-groups.json (shared with the stock pi
  extension), each session under its group with name + state marker
  (color: streaming/idle/inactive/dead), plus an (ungrouped) section.
  Sessions come from two sources merged: daemon tabs (live) and
  SessionManager.listAll() read directly by the controller (session files
  are the interface; inactive sessions spawn lazily on first prompt).
- **Keys in switcher**: up/down move, enter or right enters, esc closes;
  management on the highlighted entry: ctrl-n new, ctrl-x kill
  (context-sensitive: deactivate if active, trash+confirm if inactive),
  ctrl-r rename, ctrl-g group. A command box at the bottom of the
  switcher offers typed equivalents (/new, /kill, /rename <name>,
  /group <name>, /exit, /help; /restore later) - every hotkey has a
  command form.
- **Session view keys**: left-arrow on empty editor opens the switcher;
  typed /abort and /exit are intercepted controller-side (never
  forwarded to the child - /abort maps to the daemon abort command,
  /exit quits the controller; child exit is deactivate's job). No
  ctrl-c anywhere (feels like hard-kill).
- **pi-tui machinery**: tui.showOverlay/hideOverlay with focus management,
  SelectList for the list. Build on these, not a custom grid.
- **Hotkeys** (act on current session; decoded via matchesKey/Key):
  ctrl-n new (daemon spawn with controller cwd), ctrl-x deactivate child
  (daemon command; file stays; lazy respawn on next prompt), ctrl-r
  rename (set_session_name via daemon; inline prompt), ctrl-g group
  (write shared groups JSON; switcher list of existing groups or type name),
  ctrl-c abort/quit. The old ctrl-t tab-cycle is dropped.
- **Lifecycle**: the controller auto-starts the daemon detached on cold
  start (same node binary via process.execPath; double-checked to narrow
  simultaneous-start races) and `controller.ts kill-server` SIGTERMs it via
  the pidfile (with a /proc cmdline identity check); shutdown is orderly -
  children stop, socket and pidfile are removed.
- **Manual ordering (implemented)**: session-groups.json carries an `order`
  array of session UUIDs (both writers preserve it; extension updated).
  Display: ordered ids first, unordered after (bottom). Shift+arrows move
  the highlighted row; crossing headers reassigns groups (down = first of
  the next section, up = last of the previous); headers reorder the groups
  array; selection follows the moved item. Group headers are selectable
  rows (that is the grab point), and enter on a header opens its first
  session.
- **Palette**: theme.ts, solarized-dark via 256-color approximations (bg
  234, dim 245, accent cyan 37, streaming yellow 136, attention orange
  166). Chrome styles use scoped resets (22/39) so they compose with the
  switcher's tinted background. Solarized-light = swap one file.
- **Budget rollups**: the daemon accumulates lifetime tokens/cost per
  session from message_end usage and exposes them in session meta; the
  switcher header shows fleet totals, the status line shows the viewed
  session's.
- **Steering**: daemon prompts always use streamingBehavior "steer" - the
  same call executes when idle and queues as steering when streaming. Never
  call prompt() bare during a run (pi rejects it).
- **Trash**: delete never unlinks - the daemon moves the session file to
  ~/.local/share/ronpi/trash/ with a manifest (original path + timestamp)
  and drops its in-memory entry. The group assignment is deliberately KEPT
  so /restore brings the session back already grouped (orphan assignments
  are harmless - they attach to nothing until a session id matches).
  pi session files have no registry that can regenerate them; unlink
  would be permanent.
- **Status line** carries current session identity + ambient counts
  (N running, M waiting on permission); no permanent tab bar.

## What the pi side provides for free

RPC commands: prompt / steer / follow_up / abort / clear_queue;
new_session / switch_session / fork / clone / set_session_name;
get_state / get_messages / get_entries / get_tree / get_session_stats;
set_model / cycle_model / get_available_models; set_thinking_level /
cycle_thinking_level; compact / set_auto_compaction; bash / abort_bash;
export_html; get_commands.

- Extension commands execute via `prompt` server-side (disposition
  "handled"), even mid-stream: `/group foo`, `/skill:...`, templates.
- Extension UI forwarding: select / confirm / input dialogs arrive as
  extension_ui_request records and are answered with records. NOT custom
  components: the /sessions switcher UI and status-bar footer do not cross
  the boundary. The switcher becomes controller chrome; the status bar is
  rebuilt client-side.
- Events: message start/update/end, tool execution updates, agent_end /
  agent_settled, queue events. `agent_settled` is the "tab went idle"
  signal.
- Markdown: pi's own TUI renders assistant messages as markdown; check in
  M0 whether its interactive components (AssistantMessageComponent etc.,
  exported from the package) can be reused for the transcript view. If
  yes, requirement 9 is cheap; if no, pick a TUI-markdown renderer.

## Consequences for existing extensions (dotfiles)

- permissions.ts: unchanged, runs in each child; dialogs forwarded through
  daemon to the driving controller.
- session-groups.ts: the /group command keeps working (dialog-based); the
  switcher half is superseded by controller chrome; left-arrow hook is
  TUI-only (reborn as a controller binding). Path moves to
  ~/.local/share/ronpi/session-groups.json (shared with stock pi; migrate
  once, update the extension).
- status-bar.ts: superseded; spec reimplemented controller-side, extended
  with the session-state indicator.

## Protocol gotchas

- JSONL framing everywhere: split on LF only (Node readline also splits on
  U+2028/U+2029, which are legal inside JSON strings).
- Read streams continuously; honor backpressure both directions.
- During streaming, prompt requires streamingBehavior (steer | followUp).
- Subscribe listeners before prompting to avoid missing fast completions;
  RpcClient.promptAndWait() does this internally.
- Nested terminal context: controller inside tmux needs extended-keys
  (already configured). Kitty keyboard protocol passthrough to verify.
- Mouse: with mouse reporting on, middle-click arrives as a TuiMouseEvent;
  primary selection must be fetched via xclip (X11) / wl-paste (Wayland).
  Highlight-copy: implement selection like pi does (copy-on-select /
  OSC 52).

## Milestones

- M0 spike: **DONE, verified 2026-10-20**.
- M1 usable: **DONE, verified 2026-10-20** - switcher overlay with groups,
  session states + lazy spawn, exclusive attach + take-over, permission
  forwarding (badge-and-block, re-sent on attach), trash-based delete,
  rename, shared groups JSON in XDG data dir.
- Trial phase (current): Ron runs real work through ronpi; friction list
  drives fixes. Presence/adopt work landed 2026-10-21 (ronpi-presence
  extension, /adopt, live-in-pi markers, prompt-fork confirm, ghost
  pruning, controller announce).
- M2: the UX batch (see "M2+ roadmap" below) - quick wins first.
- NEXT BIG PROJECT: session UX (solarized, indicator, collapse); see the
  section of that name above. Controller-class split is deferred behind it.

## M2+ roadmap (tracked 2026-10-22, Ron's list)

Near-term (post-budget-reset), rough order = dependency + value:

1. Switcher quick-prompt: typing a non-command line in the switcher box +
   enter spawns a new session and delivers the text as its first prompt
   (pieces exist: spawn flow + pendingPrompt).
2. Slash autocomplete: pi-tui ships AutocompleteProvider /
   CombinedAutocompleteProvider (SlashCommand with description +
   argumentHint) - free for BOTH the switcher command box (ronpi's own
   commands) and the session editor. Ron prefers readline semantics:
   tab completes, tab-tab lists options (the provider's force flag looks
   like the hook); use the popup if it comes free. Session-side needs the
   child's command list over RPC (check rpc.md, else hardcode).
3. Status bar parity: adopt the dotfiles status-bar.ts segments verbatim
   ([session-name] dir | git:(branch) | model | ctx: used/max | thinking:
   level | $cost | prov: id, green->yellow->red "badness" gradient) in
   BOTH switcher and session views. Daemon must expose ctxUsed/ctxMax
   (from message usage + model context window), thinkingLevel
   (thinking_level_change events), and provider in SessionMeta; git branch
   is controller-side (git -C <session cwd>).
4. Paste: first test whether pi-tui's editor already handles bracketed
   paste (zero-code path); fallback = Ctrl-V / middle-click -> wl-paste
   insert (Wayland assumed, decided).
5. Session input history: **DONE 2026-10-22 for the core** - the Editor
   already had history (addToHistory + internal up/down with draft
   restore); wired addToHistory on successful submit and bound
   tui.editor.historyPrevious/Next to up/down (defaults are empty).
   Verified: recall, draft stash/restore, switcher navigation unaffected.
   Remaining: ctrl-r backward search + seeding history from the session
   file's prior user messages on entry.
6. Rewind + /fork (related, different semantics):
   - esc esc = REMOVE: pi ships a user-message-selector component (the
     same popup as its escape-escape) - reuse it, but wire selection to
     truncate the session file back to before the chosen message and
     respawn, stashing the trimmed tail in trash first (rewind stays
     reversible like delete). Not a fork.
   - /fork = explicit fork command for a LIVE session: daemon already has
     the mechanics (adopt's --fork path); generalize so any daemon-owned
     session can be forked into a sibling. Forks the file as last
     flushed; in-flight child state stays with the original.
7. In-session solarized (SCOPED, see "NEXT BIG PROJECT: session UX"): ONE theme definition living in the dotfiles
   extensions (or a shared module), consumed by the controller - in RPC
   mode the child renders nothing, so the controller does all session
   rendering; the shared definition keeps ronpi and any future pi-side
   use on one palette. Blocker to check: pi exports only
   getMarkdownTheme/getSelectListTheme/initTheme - read docs/themes.md and
   see whether initTheme accepts a custom theme object; if not, that is an
   upstream ask.
8. Rich output (SCOPED, same section): animated working/thinking indicator, show/hide thinking
   toggle, proper error rendering (message.error), better code-block
   colors (rides on 7).

## Building blocks already shipped (audit 2026-10-22)

Things pi/pi-tui give us for essentially free (* = wire-up only), found
while scoping M2:

- *Input history: our InputEditor extends pi-tui's Editor, which already
  has prompt history (addHistory + internal up/down with draft restore),
  an emacs kill ring, an undo stack, word navigation, and bracketed-paste
  handling with paste markers - we just never called addHistory. Roadmap
  #5 shrinks to "call addHistory on send"; #4's text paste is mostly
  handled by the editor itself.
- *Clipboard: pi-tui exports getNativeClipboard -> getText/getImage/
  getFilePaths (Linux via command-line tools, i.e. wl-paste/wl-copy).
  Ctrl-V text paste is nearly free; image paste = clipboard.getImage()
  plus the RPC image-content-parts check.
- Image display: pi-tui Image component renders images in the terminal
  (kitty protocol + PNG transcoder). Pairs with image paste: transcripts
  could show what was pasted.
- *Per-session /model and /thinking: the RPC protocol already has
  setModel and set_thinking_level; pi ships model-selector and
  thinking-selector popup components. Daemon passthrough + popup = new
  per-session commands.
- Rewind popup: pi's user-message-selector component (its escape-escape
  popup) - noted in roadmap #6.
- Search: alt-screen-search (search the transcript), fuzzyFilter/fuzzyMatch
  (ctrl-r, fuzzy pickers), session-selector-search (searchable session
  list - borrowable for the switcher).
- Rich output: Markdown/MarkdownTheme components, pi's diff and
  bash-execution components (proper tool-call rendering), Loader/
  CancellableLoader (animated working indicator), renderLatex (!).
- Mouse: pi-tui MouseRegion - clickable switcher rows are possible.
  ON THE ROADMAP, LOW PRIORITY (Ron, 2026-10-22).
- Terminal integration: formatProgramStatus emits OSC 7501 program status
  (idle/working/blocked + reason) - the terminal tab title could show
  "ronpi: 1 working, 1 blocked on permission" without focusing ronpi.
- KeybindingsManager: centralized keybinding config - user-configurable
  keys later.
- Colors toolkit: parseColor/okhsl/styleText - utilities for the
  solarized theme work.
- Core: buildSessionProjection (leaf projection of branched session
  files - the fix for interleaved-branch replay, currently deferred).

Caveat: the interactive-mode components (user-message-selector,
model-selector, diff, ...) are NOT exported from the package index -
importing by internal path works but is fragile across pi updates. Ron
flagged this as a concern (2026-10-22): when we first use one of these,
evaluate the best mechanism before committing to raw paths. Candidate
plan, in preference order: (1) one upstream ask exporting the interactive
components AND the theme (bundle both); (2) a single local shim module
(e.g. proto/pi-internal.ts) that re-exports every internal path we use,
so a pi update breaks exactly one file with obvious fixes; (3)
version-pin + smoke-test on pi upgrades. Decide at first use, not before.

Bigger goals - design-arounds, not scheduled:

- Claude Code as a session type: keep the daemon protocol agent-neutral
  (prompt/abort/history/session-meta are already generic); the session
  abstraction needs to grow a backend interface (spawn args, event
  mapping) with pi as the first implementation. Claude's headless
  stream-json mode is the counterpart; its project session files map onto
  the session=file model.
- Agent inter-communication by name (forks included): the daemon becomes
  a message broker. Needs stable session names (rename exists; make names
  first-class + unique), an addressing scheme (@name), and a
  pi-extension-provided tool that talks to the daemon socket (the
  presence extension already proves the socket path). Forks should
  inherit reachability.
- Sub-agent spawning: same tool path as inter-comm - an extension tool
  asking the daemon to spawn a child agent and return a handle/name;
  composes with budget (below).
- Budget tracking: per-controller (later per-agent) token budgets. The
  daemon already sums tokens/cost per session; add budget config, a
  daemon-side stop/refuse condition, and propagation into spawned
  sub-agents (needs the spawn tool).
- Web interface: the daemon protocol is transport-agnostic JSON
  (LineSplitter over unix socket today); a web UI is a WebSocket bridge
  plus a re-implementation of the controller's rendering. Keep daemon
  state terminal-free so this stays possible.
- Image paste into sessions: needs the RPC prompt path to carry image
  content parts - verify pi's rpc protocol supports them before
  designing the wl-paste -> daemon -> child path.
- Extension manager: controller installs/updates/enables extensions per
  session type (probably never, maybe fun). Today's de-facto version is
  the dotfiles extensions dir + install.sh; a manager would just formalize
  that plus per-session-type filtering.

## Risks

- pi-tui and the RPC protocol move with pi: pin the pi version; adapters
  isolated one-per-module; re-verify markdown reuse each upgrade.
- Two protocols to maintain (pi rpc + controller/daemon), three event
  vocabularies to normalize (pi events, session file entries, daemon
  records).
- Unified transcript model (live + replay) is the design linchpin; get it
  right before chrome.
- Memory per child unmeasured; cap + lazy deactivation mitigates.
- Exclusive-attach semantics can surprise (controller died while attached:
  daemon must release the lock).
