// Drift detection: a controller counts the transcript messages it has seen
// (history replay length plus the message events since); the daemon reports how
// many messages pi holds when a run settles. A mismatch means the view missed
// or doubled something, and the cure is the same as for a reconnect: replace the
// view from the daemon's history. See docs/design.md, "Display state: events
// invalidate, snapshots reconcile".

/** How many get_messages entries one live pi event adds: 1 for a finished message, an appended message entry, else 0. */
export function messagesAdded(ev: Record<string, unknown>): number {
  if (ev.type === "message_end") {
    const role = (ev.message as { role?: string } | undefined)?.role;
    return role === "user" || role === "assistant" || role === "toolResult" || role === "custom" ? 1 : 0;
  }
  if (ev.type === "entry_appended") {
    return (ev.entry as { type?: string } | undefined)?.type === "custom_message" ? 1 : 0;
  }
  return 0;
}

/** Whether a digest from the daemon shows the view out of step. A streaming session is never judged (events are in flight). */
export function drifted(seen: number | undefined, digest: { messages: number; streaming: boolean }): boolean {
  if (digest.streaming || seen === undefined) {
    return false;
  }
  return seen !== digest.messages;
}
