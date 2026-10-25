// What a controller should show for a session.
import type * as net from "node:net";
import type { DaemonContext } from "./daemon-context.ts";
import type { DaemonSession } from "./daemon-session.ts";
import { messagesFromFile } from "./transcript.ts";

/**
 * pi's in-context messages, except that once the session has been compacted the
 * file is used - it keeps the whole conversation, with a marker where the
 * compaction happened (pi's own list starts at the summary and has lost
 * everything before it). Not while a run is in flight: the file lacks the
 * message being written.
 */
export async function historyOf(s: DaemonSession): Promise<unknown[]> {
  const live = await (s.child as NonNullable<DaemonSession["child"]>).getMessages();
  if (s.streaming || !s.sessionFile) {
    return live;
  }
  try {
    const fromFile = messagesFromFile(s.sessionFile);
    return fromFile.some((m) => (m as { role?: string }).role === "compactionSummary") ? fromFile : live;
  } catch {
    return live;
  }
}

/** Replace the controller's view of the session with its current history. */
export async function sendHistory(ctx: DaemonContext, socket: net.Socket, s: DaemonSession): Promise<void> {
  ctx.hub.send(socket, { type: "history", session: s.id, messages: await historyOf(s) });
}
