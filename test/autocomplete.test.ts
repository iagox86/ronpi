import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandAutocomplete, commandsFor, type AutocompleteContext } from "../src/autocomplete.ts";
import { SESSION_COMMANDS, SWITCHER_COMMANDS } from "../src/commands.ts";

const base: AutocompleteContext = { switcher: false, piCommands: [], cwd: "/" };
const names = (ctx: AutocompleteContext) => commandsFor(ctx).map((c) => c.name);
const suggest = async (ctx: AutocompleteContext, text: string) => {
  const p = new CommandAutocomplete(() => ctx);
  const r = await p.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
  return r?.items.map((i) => i.value) ?? [];
};

describe("command autocomplete", () => {
  it("offers every registered switcher command in the switcher", () => {
    assert.deepEqual(names({ ...base, switcher: true }), SWITCHER_COMMANDS.map((c) => c.name));
  });

  it("offers toriel's session commands plus whatever pi reports", () => {
    const ctx = { ...base, piCommands: [{ name: "skill:demo", description: "d" }] };
    assert.deepEqual(names(ctx), [...SESSION_COMMANDS.map((c) => c.name), "skill:demo"]);
  });

  it("lets a toriel command win over a pi command of the same name", () => {
    const ctx = { ...base, piCommands: [{ name: "exit" }] };
    assert.equal(names(ctx).filter((n) => n === "exit").length, 1);
  });

  it("completes a typed prefix in the switcher", async () => {
    const out = await suggest({ ...base, switcher: true }, "/ki");
    assert.deepEqual(out, ["kill-daemon"]);
  });

  it("picks up commands pi reports after the provider was built", async () => {
    const ctx: AutocompleteContext = { ...base };
    assert.deepEqual(await suggest(ctx, "/skill"), []);
    ctx.piCommands = [{ name: "skill:demo" }];
    assert.deepEqual(await suggest(ctx, "/skill"), ["skill:demo"]);
  });

  it("stays out of the way for plain text in the switcher", async () => {
    assert.deepEqual(await suggest({ ...base, switcher: true }, "hello"), []);
  });
});

describe("argument completion", () => {
  const sources = {
    models: async () => ["zai/glm-5.3-flash", "zai/glm-5.3", "anthropic/claude-opus"],
    thinkingLevels: async () => ["off", "minimal", "low", "medium", "high"],
    groups: () => ["Work", "Home"],
    agents: () => [{ name: "explore", description: "look around" }],
    mcpServers: async () => [
      { name: "mealie", detail: "connected, 12 tools (direct)" },
      { name: "freecad", detail: "failed (direct)" },
    ],
  };

  it("offers the viewed session's models after /model, narrowed by the words typed", async () => {
    assert.deepEqual(await suggest({ ...base, sources }, "/model "), [
      "zai/glm-5.3-flash",
      "zai/glm-5.3",
      "anthropic/claude-opus",
    ]);
    assert.deepEqual(await suggest({ ...base, sources }, "/model zai flash"), ["zai/glm-5.3-flash"]);
  });

  it("offers group names after /group in the switcher", async () => {
    assert.deepEqual(await suggest({ ...base, switcher: true, sources }, "/group ho"), ["Home"]);
  });

  it("offers the model's thinking levels after /think, narrowed by the prefix typed", async () => {
    assert.deepEqual(await suggest({ ...base, sources }, "/think "), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    assert.deepEqual(await suggest({ ...base, sources }, "/think mi"), ["minimal"]);
  });

  it("offers the MCP actions, then the servers with their states", async () => {
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp "), ["list", "status ", "explore ", "add ", "remove ", "reconnect ", "login ", "logout "]);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp rec"), ["reconnect "]);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp reconnect "), ["reconnect mealie", "reconnect freecad"]);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp reconnect f"), ["reconnect freecad"]);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp explore f"), ["explore freecad"]);
  });

  it("does not try to complete flags", async () => {
    assert.deepEqual(await suggest({ ...base, sources }, "/model --li"), []);
  });

  it("offers nothing for commands without a fixed set of choices", async () => {
    assert.deepEqual(await suggest({ ...base, sources }, "/compact "), []);
  });
});
