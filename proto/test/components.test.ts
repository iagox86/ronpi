import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssistantMessage, UserMessage } from "../components.ts";
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

  it("puts a blank line above a user message", () => {
    const out = new UserMessage("hello", mdTheme, 1).render(40);
    assert.equal(strip(out[0] as string).trim(), "");
    assert.ok(out.some((l) => strip(l).includes("hello")));
  });
});
