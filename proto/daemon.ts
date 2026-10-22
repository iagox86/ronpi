// ronpid: owns pi sessions and their child processes, bridges them to
// controllers over a unix socket. Killing a controller never touches a child.
//
// Session model:
//   active/streaming - live child, run in flight
//   active/idle      - live child, settled
//   inactive         - no child; session file only, lazily respawned
//   dead             - child exited unexpectedly; respawnable
//
// Input on a live session is exclusively attached to one controller socket;
// event streams fan out to every connected controller (viewing is never
// exclusive). Deletes never unlink: files move to the ronpi trash dir with a
// restore manifest, because the session file is the only copy of a session.
//
// Run: node daemon.ts   (from a shell where `node` is v26; children inherit
// this env, including pi settings/auth/extensions.)
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { RpcClient, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  LineSplitter,
  encodeLine,
  type ClientCommand,
  type DaemonMessage,
  type SessionMeta,
} from "./shared.ts";

const PI_CLI =
  "/var/home/ron/.nvm/versions/node/v26.12.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

const SOCK = process.env.RONPI_SOCK ?? `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/ronpi.sock`;
const PID_FILE = `${SOCK}.pid`;
const DATA_DIR = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local", "share");
const TRASH_DIR = process.env.RONPI_TRASH ?? path.join(DATA_DIR, "ronpi", "trash");
const LOG = process.env.RONPI_LOG ?? path.join(import.meta.dirname, "daemon.log");

// Extension dialog methods block the child until answered; the rest are
// fire-and-forget (notify/setStatus/setWidget/setTitle/set_editor_text).
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function makeSession(cwd: string, sessionFile?: string): DaemonSession {
  return {
    id: nextSessionId++,
    cwd,
    sessionFile,
    model: "loading",
    messageCount: 0,
    totalTokens: 0,
    totalCost: 0,
    streaming: false,
    dead: false,
    pendingDialog: false,
    spawning: false,
  };
}

function log(msg: string): void {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // logging must never take the daemon down
  }
}

interface DaemonSession {
  id: number;
  cwd: string;
  sessionFile?: string;
  /** Live child process; undefined = inactive. */
  child?: RpcClient;
  /** Socket holding the exclusive input attach; undefined = nobody. */
  attachedTo?: net.Socket;
  sessionId?: string;
  sessionName?: string;
  model: string;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
  streaming: boolean;
  dead: boolean;
  pendingDialog: boolean;
  /** A spawn is in flight; prompts arriving meanwhile wait on `starting`. */
  spawning: boolean;
  starting?: Promise<void>;
  /** Last unanswered dialog request, re-sent to newly attached controllers. */
  lastDialog?: Record<string, unknown>;
}

const sessions = new Map<number, DaemonSession>();
/** Session files currently open in EXTERNAL pi processes (presence ext). */
const externalLive = new Map<
  string,
  { pid: number; lastSeen: number; cwd?: string; seenFile?: boolean }
>();
let nextSessionId = 1;
const sockets = new Set<net.Socket>();
let shuttingDown = false;

function send(socket: net.Socket, msg: DaemonMessage): void {
  if (!socket.destroyed) {
    socket.write(encodeLine(msg));
  }
}

function metaFor(s: DaemonSession, socket: net.Socket): SessionMeta {
  return {
    id: s.id,
    cwd: s.cwd,
    name: s.sessionName ?? "<unnamed>",
    model: s.model,
    sessionId: s.sessionId,
    sessionFile: s.sessionFile,
    messageCount: s.messageCount,
    tokens: Math.round(s.totalTokens),
    cost: Math.round(s.totalCost * 10000) / 10000,
    streaming: s.streaming,
    dead: s.dead,
    active: s.child !== undefined,
    pendingDialog: s.pendingDialog,
    attachedToYou: s.attachedTo === socket,
    attachedElsewhere: s.attachedTo !== undefined && s.attachedTo !== socket,
    externallyLive: s.sessionFile !== undefined && externalLive.has(s.sessionFile),
  };
}

// The extension's deregister message can be lost when pi exits (the socket
// write races process teardown), so process liveness is the real signal.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sessionsFor(socket: net.Socket): SessionMeta[] {
  const metas = [...sessions.values()].map((s) => metaFor(s, socket));
  // Externally-live sessions the daemon does not track are reported as
  // pseudo entries (negative ids, never addressable by prompt/attach), even
  // before pi has written the session file. The controller hides them until
  // the file is visible locally, so a row can never appear without its
  // externallyLive tag.
  const listed = new Set(metas.map((m) => m.sessionFile).filter((f) => !!f));
  let pseudo = 0;
  for (const [file, e] of externalLive) {
    if (!listed.has(file)) {
      const cwd = e.cwd || path.dirname(file);
      metas.push({
        id: -1 - pseudo++,
        cwd,
        name: path.basename(cwd),
        model: "external pi",
        sessionFile: file,
        messageCount: 0,
        streaming: false,
        dead: false,
        pendingDialog: false,
        spawning: false,
        active: false,
        externallyLive: true,
      });
    }
  }
  return metas;
}

function broadcastSessions(): void {
  for (const socket of sockets) {
    send(socket, { type: "sessions", sessions: sessionsFor(socket) });
  }
}

async function refreshMeta(s: DaemonSession): Promise<void> {
  if (!s.child) {
    return;
  }
  try {
    const state = await s.child.getState();
    s.model = state.model ? `${state.model.provider}/${state.model.id}` : "default";
    s.sessionId = state.sessionId;
    s.sessionFile = state.sessionFile ?? s.sessionFile;
    s.messageCount = state.messageCount;
    s.streaming = state.isStreaming;
    s.sessionName = state.sessionName;
    s.dead = false;
  } catch (err) {
    s.dead = true;
    s.streaming = false;
    log(`session ${s.id} refreshMeta failed: ${err}`);
  }
}

function onChildEvent(s: DaemonSession, event: Record<string, unknown>): void {
  const type = event.type as string;
  if (type === "extension_ui_request") {
    if (DIALOG_METHODS.has(event.method as string)) {
      s.pendingDialog = true;
      s.lastDialog = event;
      broadcastSessions();
    }
    // Dialogs go to the attached controller; fire-and-forget records and
    // unattached dialogs broadcast so somebody can pick them up.
    if (s.attachedTo) {
      send(s.attachedTo, { type: "ui_request", session: s.id, request: event });
    } else {
      for (const socket of sockets) {
        send(socket, { type: "ui_request", session: s.id, request: event });
      }
    }
    return;
  }
  for (const socket of sockets) {
    send(socket, { type: "event", session: s.id, event });
  }
  if (type === "message_end") {
    const usage = (event.message as { usage?: { totalTokens?: number; cost?: { total?: number } } } | undefined)?.usage;
    if (usage) {
      s.totalTokens += usage.totalTokens ?? 0;
      s.totalCost += usage.cost?.total ?? 0;
    }
  }
  if (type === "message_start" || type === "message_end" || type === "agent_start" || type === "agent_settled") {
    log(
      `session ${s.id} event: ${type}${type === "message_end" ? ` stop=${(event.message as { stopReason?: string })?.stopReason}` : ""}`,
    );
  }
  if (type === "agent_start") {
    s.streaming = true;
    broadcastSessions();
  } else if (type === "agent_settled") {
    s.streaming = false;
    void refreshMeta(s).then(broadcastSessions);
  }
}

function makeChildClient(s: DaemonSession, args: string[]): RpcClient {
  return new RpcClient({
    cliPath: PI_CLI,
    cwd: s.cwd,
    args,
    env: { ...process.env, RONPI_CHILD: "1" },
  });
}

async function startChild(
  s: DaemonSession,
  opts: { sessionFile?: string; forkPath?: string; name?: string } = {},
): Promise<void> {
  if (s.child) {
    return;
  }
  s.spawning = true;
  broadcastSessions();
  try {
    const useFile = opts.forkPath ? undefined : (opts.sessionFile ?? s.sessionFile);
    const args: string[] = [];
    if (opts.forkPath) {
      args.push("--fork", opts.forkPath);
    } else if (useFile) {
      args.push("--session", useFile);
    }
    if (opts.name) {
      args.push("--name", opts.name);
    }
    if (process.env.RONPI_THINKING) {
      args.push("--thinking", process.env.RONPI_THINKING);
    }
    if (process.env.RONPI_MODEL) {
      args.push("--model", process.env.RONPI_MODEL);
    }
    if (process.env.RONPI_PROVIDER) {
      args.push("--provider", process.env.RONPI_PROVIDER);
    }
    const client = makeChildClient(s, args);
    client.onEvent((event) => onChildEvent(s, event as Record<string, unknown>));
    await client.start();
    s.child = client;
    s.dead = false;
    await refreshMeta(s);
    log(`session ${s.id} child started (file=${s.sessionFile ?? "new"})`);
  } finally {
    s.spawning = false;
    broadcastSessions();
  }
}

async function deactivate(s: DaemonSession): Promise<void> {
  const child = s.child;
  if (!child) {
    return;
  }
  s.child = undefined;
  s.attachedTo = undefined;
  s.pendingDialog = false;
  s.streaming = false;
  try {
    await child.stop();
  } catch {
    // best effort; the process is going away regardless
  }
  log(`session ${s.id} deactivated`);
}

async function trashSessionFile(file: string): Promise<string> {
  if (!fs.existsSync(file)) {
    throw new Error(`session file does not exist: ${file}`);
  }
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const base = path.basename(file);
  let target = path.join(TRASH_DIR, base);
  if (fs.existsSync(target)) {
    target = path.join(TRASH_DIR, `${Date.now()}-${base}`);
  }
  fs.renameSync(file, target);
  fs.writeFileSync(
    `${target}.json`,
    `${JSON.stringify({ originalPath: file, trashedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  log(`trashed ${file} -> ${target}`);
  return target;
}

function findSession(cmd: { session?: number; path?: string }): DaemonSession | undefined {
  if (cmd.session !== undefined) {
    return sessions.get(cmd.session);
  }
  if (cmd.path) {
    return [...sessions.values()].find((s) => s.sessionFile === cmd.path);
  }
  return undefined;
}

type Responder = (ok: boolean, error?: string, data?: unknown) => void;

function makeResponder(socket: net.Socket, id: string | undefined): Responder {
  return (ok, error, data) => {
    if (id !== undefined) {
      send(socket, { type: "response", id, ok, error, data });
    }
  };
}

async function handlePrompt(
  cmd: Extract<ClientCommand, { type: "prompt" }>,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  let s: DaemonSession | undefined;
  if (cmd.session !== undefined) {
    s = sessions.get(cmd.session);
    if (!s) {
      throw new Error(`unknown session ${cmd.session}`);
    }
  } else if (cmd.sessionFile) {
    if (!cmd.cwd) {
      throw new Error("prompt for an untracked session requires cwd");
    }
    if (externalLive.has(cmd.sessionFile)) {
      throw new Error("session is live in another pi process - /adopt to fork it into ronpi");
    }
    s = [...sessions.values()].find((x) => x.sessionFile === cmd.sessionFile);
    if (!s) {
      s = makeSession(cmd.cwd, cmd.sessionFile);
      sessions.set(s.id, s);
      log(`session ${s.id} registered from file ${cmd.sessionFile}`);
    }
  } else {
    throw new Error("prompt requires session or sessionFile");
  }

  if (s.starting) {
    await s.starting;
  }
  if (s.child && !s.attachedTo) {
    // Free live session: the prompter implicitly takes the input attach.
    s.attachedTo = socket;
    broadcastSessions();
  }
  if (!s.child) {
    // Inactive or dead: (re)spawn, attach the requester, then prompt.
    if (s.attachedTo && s.attachedTo !== socket) {
      throw new Error("session is attached to another controller");
    }
    if (s.spawning) {
      throw new Error("spawn in progress; retry");
    }
    s.attachedTo = socket;
    await startChild(s, { sessionFile: cmd.sessionFile, name: cmd.name });
    broadcastSessions();
    const messages = await s.child!.getMessages();
    send(socket, { type: "history", session: s.id, messages });
  }
  // "steer" covers both cases: executes immediately when idle, and is
  // queued as a steering message when a run is already in flight.
  await s.child!.prompt(cmd.message, undefined, "steer");
  res(true, undefined, { disposition: "started" });
}

async function handleSpawn(
  cmd: Extract<ClientCommand, { type: "spawn" }>,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  const existing = cmd.sessionFile
    ? [...sessions.values()].find((x) => x.sessionFile === cmd.sessionFile)
    : undefined;
  const s = existing ?? makeSession(cmd.cwd, cmd.sessionFile);
  if (!existing) {
    sessions.set(s.id, s);
  }
  if (s.child && s.attachedTo && s.attachedTo !== socket) {
    throw new Error("session is attached to another controller");
  }
  if (!s.child) {
    if (s.spawning) {
      throw new Error("spawn in progress; retry");
    }
    if (s.attachedTo && s.attachedTo !== socket) {
      throw new Error("session is attached to another controller");
    }
    s.attachedTo = socket;
    // Respond as soon as the session is registered (startChild has already
    // broadcast it as spawning) so the controller can open it immediately;
    // prompts arriving before the child is up wait on s.starting.
    const starting = startChild(s, { sessionFile: cmd.sessionFile, name: cmd.name }).then(async () => {
      broadcastSessions();
      const messages = await s.child!.getMessages();
      send(socket, { type: "history", session: s.id, messages });
    });
    s.starting = starting.finally(() => {
      s.starting = undefined;
    });
    s.starting.catch((err: unknown) => {
      log(`session ${s.id} spawn failed: ${err instanceof Error ? err.message : err}`);
      s.attachedTo = undefined;
      broadcastSessions();
    });
    res(true, undefined, { sessionId: s.id });
    return;
  }
  res(true, undefined, { sessionId: s.id });
}

async function handleDelete(
  cmd: Extract<ClientCommand, { type: "delete" }>,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  const s = findSession(cmd);
  const file = s?.sessionFile ?? cmd.path;
  if (!file) {
    throw new Error("delete requires a session or path");
  }
  if (s?.child) {
    await deactivate(s);
  }
  if (s) {
    sessions.delete(s.id);
  }
  // A never-prompted session has no file on disk - dropping the entry is
  // the whole delete. Only a bare path with nothing behind it is an error.
  let trashedTo: string | undefined;
  if (fs.existsSync(file)) {
    trashedTo = await trashSessionFile(file);
  } else if (!s) {
    throw new Error(`session file does not exist: ${file}`);
  }
  broadcastSessions();
  res(true, undefined, { trashedTo });
}

async function handleRename(
  cmd: Extract<ClientCommand, { type: "rename" }>,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  const name = cmd.name.trim();
  if (!name) {
    throw new Error("name is empty");
  }
  const s = findSession(cmd);
  if (s?.child) {
    await s.child.setSessionName(name);
    await refreshMeta(s);
    broadcastSessions();
  } else if (cmd.path) {
    const mgr = SessionManager.open(cmd.path);
    mgr.appendSessionInfo(name);
  } else {
    throw new Error("rename requires a session or path");
  }
  res(true);
}

async function handleAttach(
  cmd: Extract<ClientCommand, { type: "attach" }>,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  const s = sessions.get(cmd.session);
  if (!s) {
    throw new Error(`unknown session ${cmd.session}`);
  }
  if (!s.child) {
    throw new Error("session is not active");
  }
  if (s.attachedTo === socket) {
    res(true);
    return;
  }
  if (s.attachedTo && !cmd.force) {
    throw new Error("attached to another controller (repeat to take over)");
  }
  s.attachedTo = socket;
  broadcastSessions();
  if (s.pendingDialog && s.lastDialog) {
    send(socket, { type: "ui_request", session: s.id, request: s.lastDialog });
  }
  const messages = await s.child.getMessages();
  send(socket, { type: "history", session: s.id, messages });
  res(true);
}

async function dispatch(cmd: ClientCommand, socket: net.Socket, res: Responder): Promise<void> {
  switch (cmd.type) {
    case "prompt":
      await handlePrompt(cmd, socket, res);
      break;
    case "spawn":
      await handleSpawn(cmd, socket, res);
      break;
    case "abort": {
      const s = sessions.get(cmd.session);
      if (!s?.child) {
        throw new Error("session is not active");
      }
      await s.child.abort();
      res(true);
      break;
    }
    case "deactivate": {
      const s = sessions.get(cmd.session);
      if (!s) {
        throw new Error(`unknown session ${cmd.session}`);
      }
      await deactivate(s);
      broadcastSessions();
      res(true);
      break;
    }
    case "delete":
      await handleDelete(cmd, socket, res);
      break;
    case "rename":
      await handleRename(cmd, socket, res);
      break;
    case "attach":
      await handleAttach(cmd, socket, res);
      break;
    case "detach": {
      const s = sessions.get(cmd.session);
      if (s?.attachedTo === socket) {
        s.attachedTo = undefined;
        broadcastSessions();
      }
      res(true);
      break;
    }
    case "list":
      send(socket, { type: "sessions", sessions: sessionsFor(socket) });
      res(true);
      break;
    case "shutdown":
      res(true);
      shutdown();
      break;
    case "external_register": {
      const file = cmd.sessionFile;
      if ([...sessions.values()].some((s) => (s.child as { process?: { pid?: number } } | undefined)?.process?.pid === cmd.pid)) {
        // a daemon-owned child loaded the presence extension before the
        // RONPI_CHILD guard existed - never treat our own children as
        // external
        log(`ignoring self-registration from daemon child (pid ${cmd.pid})`);
        res(true);
        break;
      }
      if (cmd.live) {
        const prev = externalLive.get(file);
        externalLive.set(file, {
          pid: cmd.pid,
          lastSeen: Date.now(),
          cwd: cmd.cwd ?? prev?.cwd,
          seenFile: (prev?.seenFile ?? false) || fs.existsSync(file),
        });
        log(`external pi registered: ${file} (pid ${cmd.pid})`);
      } else {
        externalLive.delete(file);
        log(`external pi deregistered: ${file}`);
      }
      broadcastSessions();
      res(true);
      break;
    }
    case "adopt": {
      if (!cmd.path || !fs.existsSync(cmd.path)) {
        throw new Error("adopt: session file not found");
      }
      if (!cmd.cwd) {
        throw new Error("adopt requires cwd");
      }
      const existing = [...sessions.values()].find((x) => x.sessionFile === cmd.path);
      if (existing?.child) {
        // already daemon-managed and live: nothing to adopt
        res(true, undefined, { sessionId: existing.id });
        break;
      }
      const s = existing ?? makeSession(cmd.cwd);
      sessions.set(s.id, s);
      if (s.attachedTo && s.attachedTo !== socket) {
        throw new Error("session is attached to another controller");
      }
      s.attachedTo = socket;
      s.spawning = true;
      broadcastSessions();
      try {
        const client = makeChildClient(s, ["--fork", cmd.path]);
        client.onEvent((event) => onChildEvent(s, event as Record<string, unknown>));
        await client.start();
        s.child = client;
        s.dead = false;
        await refreshMeta(s);
        log(`session ${s.id} adopted (forked from ${cmd.path})`);
      } finally {
        s.spawning = false;
        broadcastSessions();
      }
      const messages = await s.child!.getMessages();
      send(socket, { type: "history", session: s.id, messages });
      res(true, undefined, { sessionId: s.id });
      break;
    }
    case "ui_response": {
      const s = sessions.get(cmd.session);
      if (!s?.child) {
        throw new Error("session is not active");
      }
      const response = cmd.response ?? {};
      if (typeof response.id !== "string") {
        throw new Error("ui_response without id");
      }
      s.pendingDialog = false;
      s.lastDialog = undefined;
      broadcastSessions();
      // Write raw: RpcClient.send() overwrites the record's id with its own
      // correlation id, which would break the dialog reply matching, and it
      // would also wait 30s for an ack that extension_ui_response never sends.
      const record = { type: "extension_ui_response", ...response };
      const stdin = (s.child as unknown as { process?: { stdin?: { write(s: string): void } } }).process?.stdin;
      if (!stdin) {
        throw new Error("child stdin unavailable");
      }
      stdin.write(encodeLine(record));
      res(true);
      break;
    }
  }
}

// Presence-only connections (the extension's fire-and-forget heartbeats)
// never become controllers: no initial sync, no attach accounting.
const presenceSockets = new Set<net.Socket>();

function addController(socket: net.Socket): void {
  sockets.add(socket);
  // Initial sync: this socket's session view + transcript replay per child.
  send(socket, {
    type: "sessions",
    sessions: [...sessions.values()].map((s) => metaFor(s, socket)),
  });
  for (const s of sessions.values()) {
    if (s.child) {
      if (s.pendingDialog && s.lastDialog) {
        send(socket, { type: "ui_request", session: s.id, request: s.lastDialog });
      }
      void s.child
        .getMessages()
        .then((messages) => send(socket, { type: "history", session: s.id, messages }))
        .catch((err: unknown) => log(`history session ${s.id} failed: ${err}`));
    }
  }
  log(`controller attached (${sockets.size} connected)`);
}

const server = net.createServer((socket) => {
  const splitter = new LineSplitter();
  socket.on("data", (chunk: Buffer) => {
    for (const line of splitter.push(chunk.toString("utf8"))) {
      let cmd: ClientCommand;
      try {
        cmd = JSON.parse(line) as ClientCommand;
      } catch (err) {
        log(`bad client line: ${err}`);
        continue;
      }
      if (cmd.type === "external_register" && !sockets.has(socket)) {
        presenceSockets.add(socket);
      } else if (!sockets.has(socket) && !presenceSockets.has(socket)) {
        addController(socket);
      }
      void dispatch(cmd, socket, makeResponder(socket, cmd.id)).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`command ${cmd.type} failed: ${msg}`);
        makeResponder(socket, cmd.id)(false, msg);
      });
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    if (presenceSockets.delete(socket)) {
      return;
    }
    if (!sockets.delete(socket)) {
      return;
    }
    // Release any attaches held by the gone socket.
    let changed = false;
    for (const s of sessions.values()) {
      if (s.attachedTo === socket) {
        s.attachedTo = undefined;
        changed = true;
      }
    }
    if (changed) {
      broadcastSessions();
    }
    log(`controller detached (${sockets.size} connected)`);
  });
});

async function main(): Promise<void> {
  log("daemon starting");
  fs.rmSync(SOCK, { force: true });
  await new Promise<void>((resolve) => server.listen(SOCK, resolve));
  fs.writeFileSync(PID_FILE, `${process.pid}\n`);
  log(`listening on ${SOCK} (pid ${process.pid})`);

  // Prune stale external presence registrations (pid gone, or >90s without
  // heartbeat).
  // Also drop "ghosts": registrations whose session file we have seen on
  // disk and which has since been deleted (e.g. via pi's resume picker) -
  // no point listing a session that no longer exists anywhere.
  const pruner = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [file, e] of externalLive) {
      e.seenFile = e.seenFile || fs.existsSync(file);
      const deleted = e.seenFile && !fs.existsSync(file);
      const gone = !pidAlive(e.pid);
      if (deleted || gone || now - e.lastSeen > 90_000) {
        externalLive.delete(file);
        changed = true;
        log(
          deleted
            ? `external session deleted on disk: ${file}`
            : gone
              ? `external pi exited: ${file}`
              : `external presence expired: ${file}`,
        );
      }
    }
    if (changed) {
      broadcastSessions();
    }
  }, 3_000);
  pruner.unref();

  // Liveness poll: refresh metadata, notice crashed children. Also detect
  // orphaning: if our socket file is deleted (rm -rf of the runtime dir),
  // no controller can ever reach us again, so exit instead of haunting.
  const poller = setInterval(() => {
    if (!fs.existsSync(SOCK)) {
      log("socket file removed - orphaned daemon exiting");
      shutdown();
      return;
    }
    for (const s of sessions.values()) {
      if (s.child) {
        void refreshMeta(s).then(broadcastSessions);
      }
    }
  }, 15_000);
  poller.unref();
}

function shutdown(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log("daemon shutting down");
  server.close();
  for (const s of sessions.values()) {
    if (s.child) {
      void s.child.stop().catch(() => {});
    }
  }
  fs.rmSync(SOCK, { force: true });
  fs.rmSync(PID_FILE, { force: true });
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await main();
