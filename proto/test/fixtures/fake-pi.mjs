// Minimal stand-in for `pi --mode rpc`, enough for the daemon's RpcClient:
// get_state / get_messages / prompt / set_session_name / abort, JSONL on stdio.
// Like pi, the session file is only written once the first prompt arrives.
//
// Env: FAKE_PI_DIR (where new session files go; default: $TMPDIR/fake-pi-sessions), FAKE_PI_STARTUP_MS (delay
// before answering the first command), FAKE_PI_RUN_MS (how long a run lasts).
import { tmpdir } from "node:os";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const sessionId = randomUUID();
let sessionFile = flag("--session");
const forkFrom = flag("--fork");
if (!sessionFile) {
  const dir = process.env.FAKE_PI_DIR ?? join(tmpdir(), "fake-pi-sessions");
  mkdirSync(dir, { recursive: true });
  sessionFile = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
}
let sessionName = flag("--name");
const messages = [];

function loadMessages(file) {
  if (!existsSync(file)) {
    return;
  }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) {
      continue;
    }
    const entry = JSON.parse(line);
    if (entry.type === "message") {
      messages.push(entry.message);
    }
  }
}
loadMessages(forkFrom ?? sessionFile);

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const ok = (id, command, data) => out({ type: "response", id, command, success: true, data });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function persist(message) {
  messages.push(message);
  mkdirSync(dirname(sessionFile), { recursive: true });
  if (!existsSync(sessionFile)) {
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
  }
  appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message })}\n`);
}

let streaming = false;
let started = false;

async function handle(cmd) {
  if (!started) {
    started = true;
    await sleep(Number(process.env.FAKE_PI_STARTUP_MS ?? 0));
  }
  switch (cmd.type) {
    case "get_state":
      return ok(cmd.id, "get_state", {
        model: { provider: "fake", id: "fake-model" },
        isStreaming: streaming,
        sessionFile,
        sessionId,
        sessionName,
        messageCount: messages.length,
      });
    case "get_messages":
      return ok(cmd.id, "get_messages", { messages });
    case "set_session_name":
      sessionName = cmd.name;
      return ok(cmd.id, "set_session_name", null);
    case "abort":
      return ok(cmd.id, "abort", null);
    case "prompt": {
      ok(cmd.id, "prompt", { disposition: "started" });
      streaming = true;
      out({ type: "agent_start" });
      const user = { role: "user", content: cmd.message };
      out({ type: "message_start", message: user });
      persist(user);
      out({ type: "message_end", message: user });
      await sleep(Number(process.env.FAKE_PI_RUN_MS ?? 50));
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: `echo: ${cmd.message}` }],
        usage: { totalTokens: 10, cost: { total: 0.001 } },
        stopReason: "stop",
      };
      out({ type: "message_start", message: assistant });
      persist(assistant);
      out({ type: "message_end", message: assistant });
      streaming = false;
      out({ type: "agent_settled" });
      return;
    }
    default:
      return ok(cmd.id, cmd.type, null);
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line) {
      void handle(JSON.parse(line));
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
