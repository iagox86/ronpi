# Updating pi and its packages

ronpi depends on pi at two layers, and they must stay aligned:

1. **The global pi CLI** - the binary the daemon spawns for every session
   child (found on `PATH`; normally `~/.nvm/versions/node/<ver>/bin/pi`).
2. **ronpi's library dependencies** - `@earendil-works/pi-coding-agent` and
   `@earendil-works/pi-tui`, pinned in `package.json`. The controller's UI and
   the docs ronpi was built against come from these.

Version skew between the two is the normal failure mode: the daemon keeps
spawning children on the old CLI while ronpi's code and docs assume the new
one. Check with `pi --version` against the versions in `package.json`.

## What ronpi depends on (what a release can break)

- **`~/.pi/agent` tree**: `sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl`
  (read directly by the controller: transcript, fork-confirm, handled-files,
  trash/rewind), `extensions/`, `skills/`, `themes/` (written by
  `node src/install.ts`), `mcp.json`, `settings.json`.
- **pi on `PATH`**: the daemon spawns `pi` by name.
- **RPC verbs** the daemon uses: prompt, stream, `set_model`,
  `set_thinking_level`, `get_available_thinking_levels`, `mcp_status`,
  compaction events, dialog routing (`extension_ui_request`).
- **Session JSONL entry shapes**: `message`, `session_info`,
  compaction start/end events (the switcher's `compacting` marker).

Before updating, read the changelog
(<https://pi.dev/changelog>) from the installed version to the target and
check anything touching those surfaces. Breaking changes are called out under
"Breaking Changes"; the ones ronpi has absorbed so far are 1.0.3 (azure
provider rename) and 1.2.0 (extension busy semantics, `before_agent_start`
union).

## Update procedure

1. **Note current versions**: `pi --version`, the two `@earendil-works`
   entries in `package.json`, and `lastChangelogVersion` in
   `~/.pi/agent/settings.json`.
2. **Read the changelog** for everything between the CLI version and the
   target (see the dependency list above for what to look for).
3. **Update the libraries** in ronpi: bump the two `@earendil-works` entries
   in `package.json` to the target, then `npm install`.
4. **Run the gates**: `npm test`, `npm run typecheck`, `npm run lint`
   (node v26: `~/.nvm/versions/node/v26.12.0/bin`).
5. **Update the global CLI**:

   ```
   npm install -g @earendil-works/pi-coding-agent@<version>
   ```

   Prefer this over `pi update`: since 1.0.1, `pi update` on npm-global
   installs recommends migrating to the pi.dev managed installer, which moves
   the binary out of the nvm `PATH` location the daemon expects. If you do
   migrate to the managed install, verify `which pi` afterwards and expect to
   restart the daemon.

6. **Update packages**: `pi update --extensions` (permission system, web
   access, ...). Safe to do any time; live children keep the old code until
   they are reloaded or respawned.
7. **Restart the daemon** so children spawn on the new CLI. Never kill live
   sessions to do it - wait for them to go idle, or reload individual
   sessions if the change matters to them.
8. **Smoke test** (tests use fake-pi, so they cannot catch a real-CLI
   drift; this list is the actual safety net):
   - reload a session, send a message, get a reply
   - `/think` (newest RPC surface ronpi uses)
   - `/mcp list` (MCP status parsing)
   - trigger a permission dialog (ask-listed command)
   - glance at `src/daemon.log` for errors on spawn

## Rollback

Pin the CLI back: `npm install -g @earendil-works/pi-coding-agent@<old>` and
restart the daemon. ronpi's library deps can sit ahead of or behind the CLI
short-term; exact mismatches in either direction are untested territory, so
re-align both layers to the same version when practical.

## Automation

#75 tracks doing this from ronpi: detecting version skew and pending package
updates, surfacing them in the controller, and running the update with the
live-session caveats handled. Until then, this document is the process.
