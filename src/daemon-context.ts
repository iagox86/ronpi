// What every command handler works with: the daemon's collaborators, passed
// explicitly instead of read from module-level state.
import type * as net from "node:net";
import type { BridgeTracker } from "./daemon-bridge.ts";
import type { ChildManager } from "./daemon-children.ts";
import type { ClientHub } from "./daemon-hub.ts";
import type { SessionRegistry } from "./daemon-session.ts";
import type { Presence } from "./presence.ts";
import type { ClientCommand } from "./shared.ts";

export interface DaemonContext {
  registry: SessionRegistry;
  hub: ClientHub;
  children: ChildManager;
  /** Session files currently open in EXTERNAL pi processes (presence extension). */
  presence: Presence;
  /** Injects handed to session bridges and not yet seen in a transcript. */
  bridges: BridgeTracker;
  shutdown(): void;
}

export type Responder = (ok: boolean, error?: string, data?: unknown) => void;

export function makeResponder(hub: ClientHub, socket: net.Socket, id: string | undefined): Responder {
  return (ok, error, data) => {
    if (id !== undefined) {
      hub.send(socket, { type: "response", id, ok, error, data });
    }
  };
}

/** One command type's shape, e.g. Cmd<"prompt">. */
export type Cmd<T extends ClientCommand["type"]> = Extract<ClientCommand, { type: T }>;

/** Refuses to touch a session file that another pi process has open. */
export function requireNotInPi(ctx: DaemonContext, file: string): void {
  if (ctx.presence.has(file)) {
    throw new Error("session is open in another pi process; close it first");
  }
}
