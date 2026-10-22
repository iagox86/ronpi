# ronpi - design notes

## Status

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
  rename, shared groups JSON in XDG data dir. Remaining for polish:
  /restore, input/editor dialogs, solarized theme, activation cap.
- M1 usable: full state model (active/idle/inactive + lazy spawn),
  switcher with groups, permission forwarding (badge-and-block), status bar,
  exclusive attach, session files resumable by stock pi.
- M2: deactivate/reactivate + cap policy, background badges, input queuing
  to hidden tabs, mouse paste/copy, solarized theme.
- M3: split panes, search, polish; optional claude adapter.

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
