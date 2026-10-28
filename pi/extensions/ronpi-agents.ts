// ronpi agents: tools that let a session in ronpi talk to its siblings. For now
// one tool, `ronpi_message`, which delivers text to another session by id or
// name. The daemon does the work (resolving, waking an idle session, labelling
// the message); this file is the thin client that asks it. Runs only in
// children the ronpi daemon starts (RONPI_CHILD).
import { connect } from "node:net";

interface Ctx {
  sessionManager?: { getSessionId?(): string };
}
interface Pi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    parameters: unknown;
    execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
}

const sockPath = process.env.RONPI_SOCK ?? (process.env.XDG_RUNTIME_DIR ? `${process.env.XDG_RUNTIME_DIR}/ronpi.sock` : undefined);
const TIMEOUT_MS = 30_000;

/** One request/response exchange with the daemon; rejects with the daemon's error text. */
export function ask(sock: string, cmd: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = `agents-${process.pid}-${Date.now()}`;
    const s = connect(sock);
    let buf = "";
    const done = (fn: () => void) => {
      clearTimeout(timer);
      s.destroy();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error("the ronpi daemon did not answer in time"))), timeoutMs);
    s.on("connect", () => s.write(`${JSON.stringify({ ...cmd, id })}\n`));
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (const line of buf.split("\n")) {
        try {
          const msg = JSON.parse(line) as { type?: string; id?: string; ok?: boolean; error?: string; data?: Record<string, unknown> };
          if (msg.type === "response" && msg.id === id) {
            done(() => (msg.ok ? resolve(msg.data ?? {}) : reject(new Error(msg.error ?? "the daemon refused"))));
            return;
          }
        } catch {
          // a partial line; wait for more
        }
      }
    });
    s.on("error", () => done(() => reject(new Error("cannot reach the ronpi daemon"))));
  });
}

export const MESSAGE_DESCRIPTION =
  "Send a message to another ronpi session, by its session id (preferred, a UUID) or its name. The text arrives in that session as a user message labelled with your name and id, and an idle session is started to read it. It returns once delivered, not when the other session answers; if you expect a reply it arrives later as a message to you. Use this ONLY when the user asks you to tell or ask another session something - never on your own initiative.";

export default function (pi: Pi) {
  if (!process.env.RONPI_CHILD || !sockPath) {
    return;
  }
  const sock = sockPath;
  pi.registerTool({
    name: "ronpi_message",
    label: "Message",
    description: MESSAGE_DESCRIPTION,
    promptSnippet: "ronpi_message: send a message to another ronpi session (only when the user asks)",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Session id (UUID or its first 8+ characters) or the session's exact name" },
        text: { type: "string", description: "What to tell it. Self-contained: the other session sees nothing else of this conversation." },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { to, text } = params as { to: string; text: string };
      const from = process.env.RONPI_SESSION_ID ?? ctx.sessionManager?.getSessionId?.();
      try {
        const r = await ask(sock, { type: "message", to, text, from });
        const who = `${r.to ?? "the session"}${r.toId ? ` (${r.toId})` : ""}`;
        return { content: [{ type: "text", text: `Delivered to ${who}: ${r.disposition}.` }], details: r };
      } catch (err) {
        return { content: [{ type: "text", text: `Not delivered: ${err instanceof Error ? err.message : err}` }], details: { error: true } };
      }
    },
  });
}
