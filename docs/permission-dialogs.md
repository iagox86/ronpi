# Permission dialog support for pi-permission-system

Written 2026-10-23 for an implementing LLM agent. Read together with
`requirements.md` (hard requirement 5) and `design.md` ("Protocol gotchas").
Everything below about the new package's behavior was verified end-to-end
against real RPC sessions on this date; anything unverified is marked.

## What changed

On 2026-10-23 the hand-written bash permission gate
(`~/.pi/agent/extensions/permissions.ts`, saved to `~/tmp/permissions.ts`)
was retired and replaced by `@gotgenes/pi-permission-system` (unversioned
npm spec in `~/.pi/agent/settings.json`; installed copy 41.0.0). Policy
lives in `~/.pi/agent/extensions/pi-permission-system/config.json`:
top-level `"*": "allow"`, `bash: {"*": "allow", ...ask rules}`, where ask
rules are prefixes written as `"git push *": "ask"` etc. Unmatched
commands are allowed silently. There is no deny list and no path gate yet.

Consequences for the controller:

1. Ask prompts are now `select` dialogs with FOUR options, long option
   strings, and a multi-line title - not the old two-key `confirm`.
2. Choosing "No, provide reason" chains a second dialog (`input`) in the
   same turn.
3. The child blocks indefinitely while a dialog is open (the package's
   prompt timeout is opt-in and NOT configured) - badge-and-block per req 5
   is preserved; do not add a controller-side timeout.
4. Session-scoped approvals exist ("Yes, allow bash \"sudo -V\" for this
   session"): after one approval, later matches in the same child lifetime
   run silently. A session streaming with no pending dialog may still be
   in an approved state - the badge reflects open dialogs only.
5. Denial text returned to the model names the rule, e.g.:
   `[pi-permission-system] The user denied this 'bash' call (rule 'sudo *').`

## Protocol mechanics (pi docs/rpc-extension-ui.md)

Dialog methods (`select`, `confirm`, `input`, `editor`) emit an
`extension_ui_request` on the child's stdout and BLOCK until an
`extension_ui_response` with the matching `id` arrives on stdin.
Fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`,
`set_editor_text`) emit the same record type but MUST NOT be answered.

Response shapes:

- `select` -> `{"value": "<exact option string>"}` (or `cancelled: true`,
  but see change 2 below - prefer an explicit deny option).
- `confirm` -> `{"confirmed": true|false}`.
- `input`   -> `{"value": "..."}` or `{"cancelled": true}`. Cancelling the
  package's deny-reason input was verified to still complete the denial.
- `editor`  -> same family as input.

CRITICAL (design.md "Protocol gotchas"): `RpcClient.send()` overwrites the
record's id with its own correlation id and then waits 30s for an ack that
never comes. Dialog replies MUST be written raw to child stdin. The daemon
already does this - see `src/daemon.ts` `ui_response` handling ("Write
raw: RpcClient.send() overwrites the record's id..."). Keep using that
path; never "fix" it to use RpcClient.send.

## Observed payloads (verbatim, 2026-10-23 verification)

Ask dialog for `sudo -V` under rule `sudo *`:

```json
{
  "type": "extension_ui_request",
  "id": "8e451361-8446-4365-bf91-8994063424d7",
  "method": "select",
  "title": "Permission Required\ntool    : bash\nrule    : sudo *\ncommand : sudo -V",
  "options": [
    "Yes",
    "Yes, allow bash \"sudo -V\" for this session",
    "No",
    "No, provide reason"
  ]
}
```

After answering with the deny option, a chained dialog arrives:

```json
{
  "type": "extension_ui_request",
  "method": "input",
  "title": "Permission Required\nShare why this request was denied (optional).",
  "placeholder": "Reason shown back to the agent"
}
```

Also observed, and expected regularly: fire-and-forget
`{"method": "setStatus", "statusKey": "pi-permission-system"}` records
(footer state; `statusText` absent = clear). The controller must keep NOT
answering these.

## Current implementation map

- `src/config.ts` - `DIALOG_METHODS = {"select","confirm","input","editor"}`.
- `src/daemon.ts` `onChildEvent` (`extension_ui_request` branch) -
  sets `s.pendingDialog` / `s.lastDialog` for DIALOG_METHODS, forwards the
  record as `{type:"ui_request", session, request}` to the attached
  controller (or broadcasts when unattached), and answers via the
  `ui_response` command (raw stdin write, clears pendingDialog).
- `src/controller.ts` `ui_request` case - `input`/`editor` are
  AUTO-DENIED (`cancelled: true`, comment: "No free-form dialog UI yet");
  `select`/`confirm` are stored on `view.dialog` and rendered through
  `dialogPrompt`/`dialogAnswer` from `src/dialogs.ts`; `notify` is
  surfaced; everything else (setStatus etc.) is ignored.
- `src/dialogs.ts` - `dialogAnswer` (confirm: y/n; select: digit index
  into `options`, esc -> `cancelled`; input/editor: null), `dialogPrompt`
  (one-line status rendering).

## Required changes

1. **Render `select` properly** (`src/dialogs.ts` `dialogPrompt`, and
   wherever `view.dialog` is drawn). Two concrete problems with the
   current one-line rendering:
   - The title now contains embedded newlines (fact lines:
     `tool`, `rule`, `command`). Printing it raw into a status line will
     break the layout. Render the first line plus the `rule`/`command`
     lines; keep the full title available on expand if cheap.
   - Options are long (`Yes, allow bash "sudo -V" for this session`).
     A numbered vertical list (up/down + enter, plus digits) is the
     minimum; do not reorder, truncate permanently, or re-word options -
     the option string is the literal answer value sent back.
2. **Fix esc semantics on `select`.** Current code answers
   `{cancelled: true}`. That is protocol-legal but was NOT verified
   against this package, and req 5 says dismissal always means deny.
   Map esc to the explicit deny option instead: the first option starting
   with `"No"`, falling back to the last option. This is a presentation
   heuristic for identifying the deny option - acceptable precisely
   because the underlying rule is "dismissal = deny" and the option list
   is generated by the package, not the model.
3. **Keep `input` auto-cancel for now, knowingly.** The only input dialog
   this package emits is the optional deny-reason, and cancelling it was
   verified to still deliver the denial - so the current auto-deny is
   functionally correct and the reason is merely lost. Surface a real
   text prompt later if Ron wants reasons to reach the model; when doing
   so, empty submit should send `cancelled: true`.
4. **Fire-and-forget hygiene.** `setStatus`/`setWidget`/`set_editor_text`
   must never be answered and must not set `pendingDialog` - current code
   already ignores them; keep it that way. `notify` keeps surfacing.
   Optional future work: `statusKey: "pi-permission-system"` setStatus
   text could feed the status bar, and `permissions:ui_prompt` /
   `permissions:decision` exist only on the child-internal extension bus
   (not visible over RPC) - do not look for them over the wire.
5. **Re-verify through ronpi, not raw spawns.** The 2026-10-23 verification
   drove `pi --mode rpc` directly with a scripted client. ronpi's own path
   (controller -> daemon -> raw child stdin) was built for the old confirm
   flow and is believed correct (the raw-write exists precisely because of
   the RpcClient id-corruption bug), but must be exercised: restart the
   controller so children respawn onto the new package, then in a session:
   - `echo parity-ok` -> runs, no dialog.
   - `sudo -V` -> select appears; test all four answers across runs
     (Yes; Yes-for-session, then repeat the command to confirm the silent
     grant; No; No-with-reason plus a typed reason).
   - esc on the dialog -> treated as deny.
   - While the dialog is open: badge/state shows waiting, a second
     controller viewing (not attached) sees the stream but only the
     attached controller answers (existing daemon routing - unchanged).

## Non-goals / constraints

- No prompt timeout, controller-side or otherwise (req 5: no timeout,
  dismissal means deny; the package default already waits indefinitely).
- No parsing of option text beyond the deny-identification heuristic in
  change 2; no synthesizing options.
- Plain-pi TUI sessions get the package's inline hotkey dialog; ronpi
  children are RPC-only and never render it - the controller never needs
  to reproduce hotkeys (`y`/`s`/`b`/`n`/`r`).
- Known-existing caveat, unchanged by this migration: unattached dialogs
  broadcast to every controller, so more than one client can hold a stale
  `view.dialog` or (for input) auto-answer. If that ever bites, gate
  answering on input-attach in the daemon.
