import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-agentsext-"));
const sock = path.join(dir, "d.sock");
process.env.RONPI_CHILD = "1";
process.env.RONPI_SOCK = sock;
process.env.RONPI_SESSION_ID = "0b1c2d3e-aaaa-4bbb-8ccc-111111111111";
const ext = await import("../pi/extensions/ronpi-agents.ts");

/** A daemon stand-in: answers each command with `reply(cmd)`. */
function fakeDaemon(reply: (cmd: Record<string, unknown>) => { ok: boolean; error?: string; data?: unknown } | undefined): Promise<{ seen: Array<Record<string, unknown>>; close(): void }> {
  const seen: Array<Record<string, unknown>> = [];
  const server = net.createServer((s) => {
    s.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const cmd = JSON.parse(line) as Record<string, unknown>;
        seen.push(cmd);
        s.write(`${JSON.stringify({ type: "sessions", sessions: [] })}\n`); // noise a real daemon may send first
        const r = reply(cmd);
        if (r) {
          s.write(`${JSON.stringify({ type: "response", id: cmd.id, ...r })}\n`);
        }
      }
    });
  });
  fs.rmSync(sock, { force: true });
  return new Promise((resolve) => server.listen(sock, () => resolve({ seen, close: () => server.close() })));
}

function registered() {
  const tools: Array<{ name: string; description: string; execute(...a: unknown[]): Promise<{ content: Array<{ text: string }> }> }> = [];
  ext.default({ registerTool: (t: never) => tools.push(t) } as never);
  return tools;
}

describe("ronpi_message tool", () => {
  it("registers only inside a ronpi child, and tells the model to use it only when asked", () => {
    const [tool] = registered();
    assert.equal(tool?.name, "ronpi_message");
    assert.match(tool?.description ?? "", /ONLY when the user asks/);
  });

  it("sends the target, text and its own session id to the daemon and reports the delivery", async () => {
    const d = await fakeDaemon(() => ({ ok: true, data: { delivered: true, disposition: "started a turn", to: "Mealie", toId: "abc" } }));
    try {
      const out = await registered()[0]?.execute("t1", { to: "Mealie", text: "hi" }, undefined, undefined, {});
      assert.match(out?.content[0]?.text ?? "", /Delivered to Mealie \(abc\): started a turn/);
      assert.deepEqual([d.seen[0]?.type, d.seen[0]?.to, d.seen[0]?.text, d.seen[0]?.from], ["message", "Mealie", "hi", process.env.RONPI_SESSION_ID]);
    } finally {
      d.close();
    }
  });

  it("returns the daemon's refusal as text instead of throwing", async () => {
    const d = await fakeDaemon(() => ({ ok: false, error: 'no session matches "zzz"' }));
    try {
      const out = await registered()[0]?.execute("t1", { to: "zzz", text: "hi" }, undefined, undefined, {});
      assert.match(out?.content[0]?.text ?? "", /Not delivered: no session matches "zzz"/);
    } finally {
      d.close();
    }
  });

  it("says so when the daemon is not reachable", async () => {
    fs.rmSync(sock, { force: true });
    const out = await registered()[0]?.execute("t1", { to: "x", text: "hi" }, undefined, undefined, {});
    assert.match(out?.content[0]?.text ?? "", /Not delivered: cannot reach the ronpi daemon/);
  });
});
