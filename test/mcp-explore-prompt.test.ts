import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpExplorePrompt } from "../src/mcp-explore-prompt.ts";

describe("mcpExplorePrompt", () => {
  it("names the server and tells the agent how to introspect it, updating an existing skill rather than overwriting", () => {
    const p = mcpExplorePrompt("freecad");
    assert.match(p, /freecad/);
    assert.match(p, /introspect/i);
    assert.match(p, /tool/i);
    assert.match(p, /parameter/i);
    assert.match(p, /resource/i);
    assert.match(p, /mcp/i);
    assert.match(p, /MCP tool namespace/i);
    assert.match(p, /update it rather than overwriting/i);
  });

  it("points at the memory extension's skills folder first, a filesystem-safe dir name, the pi skill format, and the description frontmatter", () => {
    const p = mcpExplorePrompt("freecad");
    assert.match(p, /pi-hermes-memory\/skills/i);
    assert.match(p, /skills\/ folder/i);
    assert.match(p, /SKILL\.md/);
    assert.match(p, /filesystem-safe/i);
    assert.match(p, /frontmatter/i);
    assert.match(p, /name/);
    assert.match(p, /description/);
    assert.match(p, /surfaces the skill/i);
  });

  it("requires the skill to cover purpose, every tool, gotchas and an example, and to stay factual", () => {
    const p = mcpExplorePrompt("freecad");
    assert.match(p, /what the server is for/i);
    assert.match(p, /gotcha/i);
    assert.match(p, /example/i);
    assert.match(p, /not what you guess/i);
  });
});
