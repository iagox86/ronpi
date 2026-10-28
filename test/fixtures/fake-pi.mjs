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

const sessionId = flag("--session-id") ?? randomUUID();
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
writeFileSync(`${sessionFile}.env.json`, JSON.stringify({ RONPI_SESSION_ID: process.env.RONPI_SESSION_ID ?? null }));
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
let model = { provider: "fake", id: "fake-model", contextWindow: 100000 };
let thinkingLevel = "medium";

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
let compacting = false;
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

let bashStop;

async function handle(cmd) {
  if (!started) {
    started = true;
    await sleep(Number(process.env.FAKE_PI_STARTUP_MS ?? 0));
    if (process.env.FAKE_PI_USAGE) {
      // what the ronpi-usage extension does: a status record the daemon should consume
      out({ type: "extension_ui_request", id: "usage-1", method: "setStatus", statusKey: "ronpi-usage", statusText: process.env.FAKE_PI_USAGE });
    }
  }
  switch (cmd.type) {
    case "get_state":
      return ok(cmd.id, "get_state", {
        model,
        thinkingLevel,
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
      model = { provider: cmd.provider, id: cmd.modelId, contextWindow: 100000 };
      return ok(cmd.id, "set_model", model);
    case "get_session_stats":
      return ok(cmd.id, "get_session_stats", {
        sessionFile,
        sessionId,
        totalMessages: messages.length,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: messages.filter((m) => m.role === "assistant").length * 10 },
        cost: messages.filter((m) => m.role === "assistant").length * 0.001,
        contextUsage: { tokens: messages.length === 0 ? null : messages.length * 100, contextWindow: 100000, percent: messages.length * 0.1 },
      });
    case "set_thinking_level":
      thinkingLevel = cmd.level;
      return ok(cmd.id, "set_thinking_level", null);
    case "compact":
      compacting = true;
      await sleep(Number(process.env.FAKE_PI_COMPACT_MS ?? 0));
      compacting = false;
      return ok(cmd.id, "compact", { summary: "s", firstKeptEntryId: "x", tokensBefore: 5000, estimatedTokensAfter: 800 });
    case "bash":
      // "sleep" commands stay running until abort_bash, like a long command would
      if (cmd.command === "sleep") {
        await new Promise((resolve) => {
          bashStop = resolve;
        });
        return ok(cmd.id, "bash", { output: "", exitCode: undefined, cancelled: true, truncated: false });
      }
      return ok(cmd.id, "bash", { output: `ran: ${cmd.command}\n`, exitCode: 0, cancelled: false, truncated: false });
    case "abort_bash":
      bashStop?.();
      return ok(cmd.id, "abort_bash", null);
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
      if (compacting) {
        return out({ type: "response", id: cmd.id, command: "prompt", success: false, error: "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry." });
      }
      if (cmd.message.trim() === "/ask") {
        // a permission dialog pi settles by itself after its timeout, never answered by anyone
        ok(cmd.id, "prompt", { disposition: "started" });
        return out({ type: "extension_ui_request", id: "ask-1", method: "confirm", title: "Allow?", message: "run rm", timeout: 300 });
      }
      if (cmd.message.trim() === "/mcp") {
        // like pi's extension command: answered as a notice, never entering the conversation
        ok(cmd.id, "prompt", { disposition: "started" });
        return out({
          type: "extension_ui_request",
          id: "mcp-status",
          method: "notify",
          message: "mealie: connected, 12 tools (direct)\nfreecad: failed (direct)\n    connection refused\nconfig error: bad.json",
          notifyType: "info",
        });
      }
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
        content: [{ type: "text", text: `echo: ${cmd.message}${cmd.images?.length ? ` [${cmd.images.length} image(s): ${cmd.images.map((i) => i.mimeType).join(",")}]` : ""}` }],
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
