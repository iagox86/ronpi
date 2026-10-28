// Session-to-session messages: one session (or a person, through a tool) tells
// another something. The text lands in the target as a user message with a
// "[from NAME (uuid)]:" label (received.ts), starting the target if it is idle
// on disk. Nobody takes the target's input attach: this is a delivery, not a
// takeover, so whoever is watching keeps their place.
import type { Cmd, DaemonContext, Responder } from "./daemon-context.ts";
import { findSession } from "./daemon-resolve.ts";
import type { DaemonSession } from "./daemon-session.ts";
import { log } from "./log.ts";
import { formatReceived } from "./received.ts";

/** Name to put on a message from `fromId`: its session name, else a short id. */
async function senderName(ctx: DaemonContext, fromId: string | undefined): Promise<{ name: string; id: string }> {
  if (!fromId) {
    return { name: "another session", id: "00000000-0000-0000-0000-000000000000" };
  }
  const s = ctx.registry.all().find((x) => x.sessionId === fromId);
  return { name: s?.sessionName ?? `session ${fromId.slice(0, 8)}`, id: fromId };
}

export async function handleMessage(ctx: DaemonContext, cmd: Cmd<"message">, res: Responder): Promise<void> {
  const text = cmd.text.trim();
  if (!text) {
    throw new Error("message is empty");
  }
  const target = await findSession(ctx, cmd.to);
  if (cmd.from && target.uuid === cmd.from) {
    throw new Error("a session cannot message itself");
  }
  if (!target.file && !target.session?.child) {
    throw new Error(`${target.name ?? "that session"} has not been saved yet - nothing to deliver to`);
  }
  if (target.file && ctx.presence.has(target.file)) {
    throw new Error(`${target.name ?? "that session"} is open in another pi process - /adopt it into ronpi first`);
  }
  let s: DaemonSession | undefined = target.session;
  if (!s) {
    s = ctx.registry.byFile(target.file as string) ?? ctx.registry.create(target.cwd ?? process.cwd(), target.file);
  }
  const from = await senderName(ctx, cmd.from);
  const body = formatReceived(from.name, from.id, text);
  if (s.starting) {
    await s.starting;
  }
  if (s.held) {
    // compacting: pi refuses prompts, so it waits with the others, in order
    s.held.push({ text: body });
    ctx.hub.announceQueue(s.id, s.held.map((h) => h.text));
    res(true, undefined, { delivered: true, disposition: "queued until compaction ends", to: target.name, toId: target.uuid });
    return;
  }
  if (!s.child) {
    if (s.spawning) {
      throw new Error("that session is starting; try again in a moment");
    }
    await ctx.children.start(s, { sessionFile: target.file });
    ctx.hub.broadcastSessions();
  }
  const busy = s.streaming;
  await (s.child as NonNullable<typeof s.child>).prompt(body, undefined, "steer");
  log(`message from ${from.name} to session ${s.id} (${busy ? "queued" : "started"})`);
  res(true, undefined, {
    delivered: true,
    disposition: busy ? "queued behind the work in progress" : "started a turn",
    to: target.name,
    toId: target.uuid ?? s.sessionId,
  });
}
