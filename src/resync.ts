// What a controller keeps of a session view when the daemon replays that
// session's history. A replay after a lost connection is the daemon's truth for
// everything: activity, queue, dialog and unechoed prompts from before the loss
// are stale and must not survive. A replay during a live connection only has to
// keep what raced ahead of it.
import type { Item, SessionView } from "./transcript.ts";
import { newView } from "./transcript.ts";

export function viewFromHistory(old: SessionView | undefined, items: Item[], afterReconnect: boolean, messages?: number): SessionView {
  const fresh: SessionView = { ...newView(), items, messages };
  if (afterReconnect || !old) {
    return fresh;
  }
  // keep live activity if events raced ahead of the history reply
  fresh.activity = old.activity;
  fresh.queue = old.queue;
  // the daemon sends a pending dialog just before the history; replacing the view must not lose it
  fresh.dialog = old.dialog;
  // prompts sent but not yet echoed by pi are not in the child's history
  for (const echo of old.echoes) {
    fresh.echoes.push(echo);
    fresh.items.push(echo.item);
  }
  return fresh;
}

/** Views of sessions the daemon will not replay (no live child) lose their transient state on reconnect. */
export function clearTransient(view: SessionView): void {
  view.activity = undefined;
  view.queue = [];
  view.dialog = undefined;
  view.echoes = [];
  view.echoActivity = undefined;
  view.streaming = undefined;
}
