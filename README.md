# ronpi

A daemon-backed controller that hosts multiple live pi sessions in one
terminal. Pick a session from a grouped switcher, keep agents running in the
background, switch between them without aborting anything, and never lose work
to a crashed UI. Think "tmux for pi sessions": the daemon owns the pi
processes, controllers (the terminal UI) come and go.

pi runs one agent per process, and switching sessions inside one pi aborts
the run in flight. ronpi keeps each session's pi process in a daemon, so
closing or crashing the UI never touches a running agent.

## Install

Requirements:

- Node v26.12.0 or newer (the code is TypeScript run directly by node; the
  `.nvmrc` pins it). With nvm: `nvm install 26.12.0`. Note that an older
  default node will not work.
- pi installed globally under that node (`npm install -g @earendil-works/pi-coding-agent`)
  and logged in to at least one provider
- A truecolor terminal; one with the kitty keyboard protocol (kitty, ghostty, wezterm, ...) gives the best key handling
- Optional, for clipboard and image paste: `wl-clipboard` (Wayland) or `xclip` (X11).
  ronpi checks at startup and says so in the switcher if they are missing.

```fish
git clone <this repo> ~/projects/ronpi
cd ~/projects/ronpi
npm install
node src/install.ts     # links ronpi's pi extensions and theme into ~/.pi/agent
```

`node src/install.ts` refuses to replace a file that is not its own link; move
an older copy aside and rerun. It honors `PI_CODING_AGENT_DIR`.

## Run

```fish
node ronpi.ts              # starts the daemon if needed, opens the switcher
node ronpi.ts kill-server  # stop the daemon and every session it owns
```

Put a shell function or alias on that command to get a short name, for
example in fish: `alias piron 'node ~/projects/ronpi/ronpi.ts'`.

Quitting ronpi (`/exit`) leaves the daemon and all running sessions alone;
starting it again reattaches to everything.

## Using it

The switcher lists every pi session, live or not, in groups. Start typing to
begin a new session, or use the keys below.

| Key | Where | Does |
| --- | --- | --- |
| up / down, enter or right | switcher | select, open |
| shift+up / shift+down | switcher | move a session or group (crossing a header changes group) |
| ctrl-n | switcher | new session |
| ctrl-k | switcher | stop the session's process (file kept) |
| ctrl-x (twice) | switcher | delete (to trash, recoverable with `/restore`) |
| ctrl-r or f2 | switcher | rename |
| ctrl-g, ctrl-f | switcher | group, filter |
| left / right / enter on a group | switcher | fold or unfold |
| left on an empty editor | session | back to the switcher |
| esc | session | abort the running agent |
| esc esc | session | rewind to an earlier message |
| ctrl-o, ctrl-t | session | expand tool output, show thinking |
| ctrl-r | session | search prompt history |
| ctrl-v, middle click | both | paste clipboard (text or image), paste selection |

Type `/` for commands; tab completes them and their arguments, and
`/<command> --help` explains one. Commands ronpi handles itself:

- Switcher: `/new`, `/stop`, `/delete`, `/rename`, `/group`, `/ungroup`, `/park`,
  `/filter`, `/summarize`, `/restore`, `/adopt`, `/feedback`, `/kill-daemon`, `/help`, `/exit`
- In a session: `/model`, `/compact`, `/clear`, `/fork`, `/park`, `/rename`, `/reload`,
  `/mcp` (`list`, `add`, `reconnect`, `login`, `logout`), `/init`, `/why`, `/abort`,
  `/feedback`, `/quit` (back to the switcher), `/exit`

Anything else starting with `/` goes to pi (its skills and prompt templates).

`!command` in a session runs a shell command in the session's directory and
shows the output; the agent sees both on its next turn (pi records it as part of
the conversation). `esc` stops it. It needs a running session and an idle agent,
and pi's RPC allows a command about 30 seconds to answer. `!!` (output hidden
from the agent) is not supported.

Sessions opened in plain pi appear in the list too. With the `ronpi-presence`
extension (installed by `node src/install.ts`) they are marked as live in pi;
continuing one in ronpi forks it.

## Settings

`~/.config/ronpi/settings.json` (all keys optional): `steeringMode`, `provider`,
`model`, `thinking`, `piCli`. Environment variables (`RONPI_*`) override it.
Full list and semantics: [docs/reference.md](docs/reference.md).

## Development

```fish
npm test            # unit and daemon tests (no network, no model; uses a fake pi)
npm run typecheck   # tsc --noEmit
npm run lint        # biome
```

Layout:

- `ronpi.ts` - entry point
- `src/` - daemon and controller source (see "Code layout" in docs/reference.md)
- `test/` - tests and the fake-pi fixture
- `pi/` - what ronpi installs into pi: extensions (presence, usage, cache warning) and the theme
- `docs/` - `reference.md` (keys, semantics, env), `design.md` (architecture, findings, backlog),
  `requirements.md`, `permission-dialogs.md`
- `AGENTS.md` - instructions for coding agents working in this repo
