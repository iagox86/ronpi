// The connected controller sockets: fan-out of messages to them, and which
// sockets count as controllers at all.
import type * as net from "node:net";
import { encodeLine, type DaemonMessage, type SessionMeta } from "./shared.ts";

export class ClientHub {
  private readonly controllers = new Set<net.Socket>();
  /**
   * Presence-only connections (the extension's fire-and-forget heartbeats)
   * never become controllers: no initial sync, no attach accounting.
   */
  private readonly presenceOnly = new Set<net.Socket>();
  private readonly metasFor: (socket: net.Socket) => SessionMeta[];

  /** `metasFor` builds the session list as one particular socket should see it (its own attaches differ). */
  constructor(metasFor: (socket: net.Socket) => SessionMeta[]) {
    this.metasFor = metasFor;
  }

  get controllerCount(): number {
    return this.controllers.size;
  }

  isController(socket: net.Socket): boolean {
    return this.controllers.has(socket);
  }

  isKnown(socket: net.Socket): boolean {
    return this.controllers.has(socket) || this.presenceOnly.has(socket);
  }

  addController(socket: net.Socket): void {
    this.controllers.add(socket);
  }

  addPresenceOnly(socket: net.Socket): void {
    this.presenceOnly.add(socket);
  }

  /** Forget a closed socket; says which kind it was, so the caller knows whether to clean up after it. */
  remove(socket: net.Socket): "controller" | "presence" | "unknown" {
    if (this.presenceOnly.delete(socket)) {
      return "presence";
    }
    return this.controllers.delete(socket) ? "controller" : "unknown";
  }

  send(socket: net.Socket, msg: DaemonMessage): void {
    if (!socket.destroyed) {
      socket.write(encodeLine(msg));
    }
  }

  /** The same message to every controller. */
  broadcast(msg: DaemonMessage): void {
    for (const socket of this.controllers) {
      this.send(socket, msg);
    }
  }

  sendSessions(socket: net.Socket): void {
    this.send(socket, { type: "sessions", sessions: this.metasFor(socket) });
  }

  broadcastSessions(): void {
    for (const socket of this.controllers) {
      this.sendSessions(socket);
    }
  }

  /** Tell controllers which messages are waiting, in the shape of pi's own queue_update. */
  announceQueue(sessionId: number, texts: string[]): void {
    this.broadcast({ type: "event", session: sessionId, event: { type: "queue_update", steering: texts, followUp: [] } });
  }
}
