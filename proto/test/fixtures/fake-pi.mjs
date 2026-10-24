// Minimal stand-in for `pi --mode rpc`, enough for the daemon's RpcClient:
// get_state / get_messages / prompt / set_session_name / abort, JSONL on stdio.
// Like pi, the session file is only written once the first prompt arrives.
//
// Env: FAKE_PI_DIR (where new session files go; default: $TMPDIR/fake-pi-sessions), FAKE_PI_STARTUP_MS (delay
// before answering the first command), FAKE_PI_RUN_MS (how long a run lasts).
// FAKE_PI_SLOW=1 scripts a realistic run (thinking deltas, a bash tool call,
// streamed text; a prompt containing "fail" ends in a provider error). Each
// step lasts FAKE_PI_STEP_MS (default 400). Prompts that arrive mid-run queue
// (queue_update) and are delivered together when the turn ends, like pi's
// steeringMode "all".
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
// let tests see how the daemon launched this child
mkdirSync(dirname(sessionFile), { recursive: true });
writeFileSync(`${sessionFile}.argv.json`, JSON.stringify(args));
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

let lastEntryId = null;
let model = { provider: "fake", id: "fake-model" };

function persist(message) {
  messages.push(message);
  mkdirSync(dirname(sessionFile), { recursive: true });
  if (!existsSync(sessionFile)) {
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
  }
  const id = randomUUID().slice(0, 8);
  appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id, parentId: lastEntryId, timestamp: new Date().toISOString(), message })}\n`);
  lastEntryId = id;
}

let streaming = false;
let started = false;
let aborted = false;
const slow = process.env.FAKE_PI_SLOW === "1";
const stepMs = Number(process.env.FAKE_PI_STEP_MS ?? 400);
const queue = [];
const queueUpdate = () => out({ type: "queue_update", steering: [...queue], followUp: [] });

async function pause() {
  await sleep(stepMs);
  return !aborted;
}

// One scripted turn answering `texts` (already-delivered user messages).
async function slowRun(texts) {
  const prompt = texts.join("\n");
  const partial = { role: "assistant", content: [] };
  out({ type: "message_start", message: partial });
  const update = (e) => out({ type: "message_update", message: partial, assistantMessageEvent: e });
  update({ type: "thinking_start", contentIndex: 0 });
  for (const word of ["Let me", " think", " about", " that..."]) {
    if (!(await pause())) {
      return;
    }
    update({ type: "thinking_delta", contentIndex: 0, delta: word });
  }
  update({ type: "thinking_end", contentIndex: 0, content: "Let me think about that..." });
  if (prompt.includes("fail")) {
    const err = { role: "assistant", content: [], stopReason: "error", errorMessage: "provider exploded" };
    out({ type: "message_end", message: err });
    return;
  }
  const args = { command: "ls" };
  out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args });
  if (!(await pause())) {
    return;
  }
  out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "a.ts\nb.ts" }] } });
  update({ type: "text_start", contentIndex: 1 });
  for (const word of ["echo: ", prompt]) {
    if (!(await pause())) {
      return;
    }
    update({ type: "text_delta", contentIndex: 1, delta: word });
  }
  const final = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think about that..." },
      { type: "text", text: `echo: ${prompt}` },
    ],
    usage: { totalTokens: 10, cost: { total: 0.001 } },
    stopReason: "stop",
  };
  persist(final);
  out({ type: "message_end", message: final });
}

async function slowPrompt(first) {
  streaming = true;
  aborted = false;
  out({ type: "agent_start" });
  let texts = [first];
  while (texts.length > 0) {
    for (const t of texts) {
      const user = { role: "user", content: t };
      out({ type: "message_start", message: user });
      persist(user);
      out({ type: "message_end", message: user });
    }
    await slowRun(texts);
    texts = queue.splice(0, queue.length);
    if (texts.length > 0) {
      queueUpdate();
    }
  }
  streaming = false;
  out({ type: "agent_settled" });
}

async function handle(cmd) {
  if (!started) {
    started = true;
    await sleep(Number(process.env.FAKE_PI_STARTUP_MS ?? 0));
  }
  switch (cmd.type) {
    case "get_state":
      return ok(cmd.id, "get_state", {
        model,
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
    case "get_available_models":
      return ok(cmd.id, "get_available_models", {
        models: [
          { provider: "fake", id: "fake-model", contextWindow: 1000, reasoning: false },
          { provider: "fake", id: "fake-big", contextWindow: 9000, reasoning: true },
          { provider: "other", id: "fake-big", contextWindow: 9000, reasoning: true },
        ],
      });
    case "set_model":
      model = { provider: cmd.provider, id: cmd.modelId };
      return ok(cmd.id, "set_model", model);
    case "compact":
      return ok(cmd.id, "compact", { summary: "s", firstKeptEntryId: "x", tokensBefore: 5000, estimatedTokensAfter: 800 });
    case "abort":
      aborted = true;
      return ok(cmd.id, "abort", null);
    case "get_commands":
      return ok(cmd.id, "get_commands", {
        commands: [
          { name: "skill:demo", description: "A demo skill", source: "skill" },
          { name: "compact", description: "Compact the context", source: "extension" },
        ],
      });
    case "clear_queue": {
      const steering = queue.splice(0, queue.length);
      queueUpdate();
      return ok(cmd.id, "clear_queue", { steering, followUp: [] });
    }
    case "prompt": {
      if (slow) {
        if (streaming) {
          queue.push(cmd.message);
          queueUpdate();
          return ok(cmd.id, "prompt", { disposition: "queued" });
        }
        ok(cmd.id, "prompt", { disposition: "started" });
        return slowPrompt(cmd.message);
      }
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
