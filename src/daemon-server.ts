// The unix-socket server: turns connections into controllers, lines into
// commands, and closed sockets into released attaches.
import * as net from "node:net";
import type { DaemonContext } from "./daemon-context.ts";
import { makeResponder } from "./daemon-context.ts";
import { dispatch } from "./daemon-dispatch.ts";
import { historyOf } from "./daemon-history.ts";
import { log } from "./log.ts";
import { type ClientCommand, LineSplitter } from "./shared.ts";

/** A new controller's initial sync: its own session view, then the transcript of every live child. */
function syncController(ctx: DaemonContext, socket: net.Socket): void {
  ctx.hub.addController(socket);
  ctx.hub.sendSessions(socket);
  for (const s of ctx.registry.all()) {
    if (!s.child) {
      continue;
    }
    if (s.pendingDialog && s.lastDialog) {
      ctx.hub.send(socket, { type: "ui_request", session: s.id, request: s.lastDialog });
    }
    void historyOf(s)
      .then((messages) => ctx.hub.send(socket, { type: "history", session: s.id, messages }))
      .catch((err: unknown) => log(`history session ${s.id} failed: ${err}`));
  }
  log(`controller attached (${ctx.hub.controllerCount} connected)`);
}

/** Release every attach a gone controller held. */
function releaseAttaches(ctx: DaemonContext, socket: net.Socket): void {
  let changed = false;
  for (const s of ctx.registry.all()) {
    if (s.attachedTo === socket) {
      s.attachedTo = undefined;
      changed = true;
    }
  }
  if (changed) {
    ctx.hub.broadcastSessions();
  }
}

export function createServer(ctx: DaemonContext): net.Server {
  return net.createServer((socket) => {
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
        // one-shot callers (presence heartbeats, the agents extension) are not controllers: no sync, no attaches
        if ((cmd.type === "external_register" || cmd.type === "message") && !ctx.hub.isController(socket)) {
          ctx.hub.addPresenceOnly(socket);
        } else if (!ctx.hub.isKnown(socket)) {
          syncController(ctx, socket);
        }
        const res = makeResponder(ctx.hub, socket, cmd.id);
        void dispatch(ctx, cmd, socket, res).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log(`command ${cmd.type} failed: ${msg}`);
          res(false, msg);
        });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (ctx.hub.remove(socket) === "controller") {
        releaseAttaches(ctx, socket);
        log(`controller detached (${ctx.hub.controllerCount} connected)`);
      }
    });
  });
}
