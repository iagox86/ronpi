// Finding a session from what someone typed: the daemon's own sessions first,
// then the session files on disk (slower), so a never-opened session works too.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Cmd, DaemonContext, Responder } from "./daemon-context.ts";
import type { DaemonSession } from "./daemon-session.ts";
import { resolveSession } from "./session-id.ts";

export interface FoundSession {
  /** Daemon number; -1 when only the file is known. */
  id: number;
  uuid?: string;
  name?: string;
  file?: string;
  cwd?: string;
  /** The daemon's record, when it holds one. */
  session?: DaemonSession;
}

/** Throws a user-readable error when nothing, or more than one session, matches. */
export async function findSession(ctx: DaemonContext, query: string): Promise<FoundSession> {
  const known: FoundSession[] = ctx.registry.all().map((s) => ({ id: s.id, uuid: s.sessionId, name: s.sessionName, file: s.sessionFile, cwd: s.cwd, session: s }));
  const asAddressable = (list: FoundSession[]) => list.map((f) => ({ ...f, sessionId: f.uuid, sessionName: f.name }));
  let r = resolveSession(query, asAddressable(known));
  if (r.kind === "none") {
    const infos = await SessionManager.listAll();
    const onDisk: FoundSession[] = infos.map((i) => ({ id: -1, uuid: i.id, name: i.name, file: i.path, cwd: i.cwd }));
    r = resolveSession(query, asAddressable(onDisk));
  }
  if (r.kind === "none") {
    throw new Error(`no session matches "${query}"`);
  }
  if (r.kind === "ambiguous") {
    const shown = r.matches.slice(0, 5).map((m) => `${m.sessionName ?? "(unnamed)"} ${m.sessionId ?? "?"}`).join("; ");
    throw new Error(`"${query}" matches ${r.matches.length} sessions (${shown}) - use the session id`);
  }
  const { sessionId: _a, sessionName: _b, ...found } = r.session;
  return found;
}

export async function handleResolve(ctx: DaemonContext, cmd: Cmd<"resolve">, res: Responder): Promise<void> {
  const f = await findSession(ctx, cmd.query);
  res(true, undefined, { uuid: f.uuid, name: f.name, file: f.file, id: f.id >= 0 ? f.id : undefined });
}
