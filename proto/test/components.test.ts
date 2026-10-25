import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssistantMessage, CompactionRow, Dimmed, UserMessage } from "../components.ts";
import { mdTheme } from "../pi-theme.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("message components", () => {
  it("renders code blocks without fence lines but keeps the code", () => {
    const msg = { role: "assistant", content: [{ type: "text", text: "Here:\n\n```sh\ncat /etc/passwd\n```\n\nDone" }], stopReason: "stop" };
    const out = new AssistantMessage(msg as never, true, mdTheme, undefined, 1).render(60).map(strip).join("\n");
    assert.doesNotMatch(out, /```/);
    assert.match(out, /cat \/etc\/passwd/);
    assert.match(out, /Done/);
  });

  it("shows a tidied provider error, and the original text on request", () => {
    const raw = '403: {"message":"{\\"error\\":{\\"message\\":\\"Budget exceeded\\"}}","type":"budget_exceeded"}';
    const msg = { role: "assistant", content: [], stopReason: "error", errorMessage: raw };
    const comp = new AssistantMessage(msg as never, true, mdTheme, undefined, 1);
    const tidy = comp.render(120).map(strip).join("\n");
    assert.match(tidy, /budget_exceeded: Budget exceeded/);
    assert.doesNotMatch(tidy, /\{/);
    comp.setShowRawError(true);
    assert.match(comp.render(120).map(strip).join("\n"), /\{"message"/);
    comp.setShowRawError(false);
    assert.doesNotMatch(comp.render(120).map(strip).join("\n"), /\{/);
  });

  it("puts a blank line above a user message", () => {
    const out = new UserMessage("hello", mdTheme, 1).render(40);
    assert.equal(strip(out[0] as string).trim(), "");
    assert.ok(out.some((l) => strip(l).includes("hello")));
  });
});

describe("Dimmed", () => {
  it("renders the inner lines faint and keeps them faint across resets", () => {
    const lines = new Dimmed({ render: () => ["a\x1b[0mb"], invalidate() {} }).render(10);
    assert.equal(lines[0], "\x1b[2ma\x1b[0m\x1b[2mb\x1b[22m");
  });
});

describe("CompactionRow", () => {
  it("tells you which key expands the summary", () => {
    const row = new CompactionRow({ role: "compactionSummary", summary: "s", tokensBefore: 50110, timestamp: 0 }, mdTheme, 1);
    const text = row.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(text, /Compacted from 50,110 tokens \(ctrl-o to expand\)/);
  });
});

describe("render caching", () => {
  it("renders a dimmed component once per width until invalidated", () => {
    let renders = 0;
    const inner = {
      render: () => {
        renders++;
        return ["x"];
      },
      invalidate() {},
    };
    const d = new Dimmed(inner);
    d.render(80);
    d.render(80);
    assert.equal(renders, 1);
    d.render(60);
    assert.equal(renders, 2);
    d.invalidate();
    d.render(60);
    assert.equal(renders, 3);
  });
});
