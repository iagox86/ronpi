// Delivering a message into a live session: through its session bridge
// (the ronpi-session-bridge extension, reached as the `/ronpi-inject` command over
// the child's own RPC pipe) when it has one, else through pi's steering queue.
// See docs/design.md, "Session bridge". Only messages from other sessions come
// here; the user's own prompts stay ordinary user messages.
import { INJECT_COMMAND, mergedQueueTexts } from "./daemon-bridge.ts";
import type { DaemonContext } from "./daemon-context.ts";
import type { DaemonSession } from "./daemon-session.ts";
import { log } from "./log.ts";

/** Tell controllers what the strip should show: compaction-held messages, then the bridge's pending. */
export function announceBridgeQueue(ctx: DaemonContext, s: DaemonSession): void {
  ctx.hub.announceQueue(s.id, mergedQueueTexts((s.held ?? []).map((h) => h.text), ctx.bridges.texts(s.id)));
}

/** Deliver `body` into a live session; returns which path carried it. The caller guarantees a live child. */
export async function deliverToSession(ctx: DaemonContext, s: DaemonSession, body: string): Promise<"bridge" | "legacy"> {
  const child = s.child;
  if (!child) {
    throw new Error("the session has no live child to receive the message");
  }
  if (s.sessionBridge === undefined) {
    await ctx.children.detectBridge(s);
  }
  if (s.sessionBridge) {
    const id = ctx.bridges.newId();
    ctx.bridges.track(s.id, { id, text: body });
    announceBridgeQueue(ctx, s);
    try {
      await child.prompt(`/${INJECT_COMMAND} ${JSON.stringify({ id, text: body })}`);
      return "bridge";
    } catch (err) {
      // the command never reached the extension: nothing is pending there, so steer instead
      ctx.bridges.fail(s.id, id);
      announceBridgeQueue(ctx, s);
      log(`session ${s.id}: bridge inject ${id} was refused (${err instanceof Error ? err.message : err}); using steering`);
    }
  } else if (ctx.bridges.shouldWarnLegacy(s.id)) {
    log(`session ${s.id}: no session bridge; using legacy steering. Fix with node src/install.ts, then restart the session.`);
  }
  await child.prompt(body, undefined, "steer");
  return "legacy";
}
