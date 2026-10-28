import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INIT_PROMPT } from "../src/init-prompt.ts";

describe("init prompt", () => {
  it("makes AGENTS.md the only file the agent writes", () => {
    assert.match(INIT_PROMPT, /write an AGENTS\.md/);
    assert.match(INIT_PROMPT, /AGENTS\.md is the only file you write/);
  });

  it("says to fold in CLAUDE.md and the other standard instruction files", () => {
    assert.match(INIT_PROMPT, /CLAUDE\.md/);
    assert.match(INIT_PROMPT, /GEMINI\.md/);
    assert.match(INIT_PROMPT, /\.cursorrules/);
    assert.match(INIT_PROMPT, /copilot-instructions\.md/);
  });

  it("keeps the update-existing-file rule", () => {
    assert.match(INIT_PROMPT, /If one already exists, read it first and update it rather than starting over/);
  });
});
