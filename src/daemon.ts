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
import { PID_FILE, SOCK } from "./config.ts";
import { BridgeTracker } from "./daemon-bridge.ts";
import { ChildManager } from "./daemon-children.ts";
import type { DaemonContext } from "./daemon-context.ts";
import { ClientHub } from "./daemon-hub.ts";
import { sessionMetas } from "./daemon-meta.ts";
import { createServer } from "./daemon-server.ts";
import { SessionRegistry } from "./daemon-session.ts";
import { agentDir } from "./install.ts";
import { log } from "./log.ts";
import { Presence } from "./presence.ts";
import { auditRequired, describeProblems } from "./required.ts";
import type { UsageReport } from "./shared.ts";

/** Wire the daemon's collaborators together; `shutdown` is late-bound because they need each other first. */
function createContext(shutdown: () => void): DaemonContext {
  const registry = new SessionRegistry();
  const presence = new Presence();
  const usage = new Map<string, UsageReport>();
  const hub = new ClientHub((socket) => sessionMetas(registry, presence, usage, socket));
  const bridges = new BridgeTracker();
  const children = new ChildManager(hub, usage, bridges);
  return { registry, hub, children, presence, bridges, shutdown };
}

async function main(): Promise<void> {
  let shuttingDown = false;
  const ctx = createContext(() => shutdown());
  const server = createServer(ctx);

  function shutdown(): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log("daemon shutting down");
    server.close();
    for (const s of ctx.registry.all()) {
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

  log("daemon starting");
  fs.rmSync(SOCK, { force: true });
  // The socket is an unauthenticated command channel (spawn, prompt, ...), so it
  // must be owner-only from the moment it exists: the umask covers the bind,
  // the chmod covers a umask that was looser than we asked for.
  const prevMask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(SOCK, resolve);
    });
  } catch (err) {
    // the daemon runs detached with no stdio, so the log is the only place this shows
    log(`cannot listen on ${SOCK}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  } finally {
    process.umask(prevMask);
  }
  fs.chmodSync(SOCK, 0o600);
  fs.writeFileSync(PID_FILE, `${process.pid}\n`, { mode: 0o600 });
  log(`listening on ${SOCK} (pid ${process.pid})`);
  // Warn only: linking files into the pi agent dir unasked would be a surprise.
  const missing = describeProblems(auditRequired(agentDir()));
  if (missing) {
    log(`WARNING: ${missing}`);
  }

  // Prune external presence registrations whose pi exited, whose session
  // file was deleted (e.g. via pi's resume picker), or that stopped
  // heartbeating.
  const pruner = setInterval(() => {
    const dropped = ctx.presence.prune();
    for (const { file, reason } of dropped) {
      log(`external presence dropped (${reason}): ${file}`);
    }
    if (dropped.length > 0) {
      ctx.hub.broadcastSessions();
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
    for (const s of ctx.registry.all()) {
      if (s.child) {
        void ctx.children.refreshMeta(s).then(() => ctx.hub.broadcastSessions());
      }
    }
  }, 15_000);
  poller.unref();
}

await main();
