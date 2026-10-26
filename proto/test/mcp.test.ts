import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpCompletions, parseMcpStatus } from "../mcp.ts";

const STATUS = [
  "mealie: connected, 12 tools (direct)",
  "freecad: failed (direct)",
  "    connect ECONNREFUSED 127.0.0.1:39280",
  "sentry: needs sign-in, run /mcp login sentry (direct)",
  "old: disabled (direct)",
  "config error: bad.json is not valid JSON",
  "overridden: docs (project entry wins)",
].join("\n");

describe("parseMcpStatus", () => {
  it("reads one server per unindented line and skips errors and overrides", () => {
    assert.deepEqual(parseMcpStatus(STATUS).map((s) => s.name), ["mealie", "freecad", "sentry", "old"]);
  });

  it("keeps the state text as the detail, without the indented error tail", () => {
    const freecad = parseMcpStatus(STATUS).find((s) => s.name === "freecad");
    assert.equal(freecad?.detail, "failed (direct)");
  });

  it("finds no servers in the 'none configured' message or in an empty reply", () => {
    assert.deepEqual(parseMcpStatus("No MCP servers configured. Add them to /x/mcp.json or .pi/mcp.json."), []);
    assert.deepEqual(parseMcpStatus(""), []);
  });
});

describe("mcpCompletions", () => {
  const servers = parseMcpStatus(STATUS);

  it("offers the actions for the first word, narrowed by what is typed", () => {
    assert.deepEqual(mcpCompletions("", servers).map((c) => c.value), ["list", "reconnect ", "login ", "logout "]);
    assert.deepEqual(mcpCompletions("lo", servers).map((c) => c.value), ["login ", "logout "]);
  });

  it("offers the servers after reconnect, login or logout, each with its state", () => {
    const out = mcpCompletions("reconnect ", servers);
    assert.deepEqual(out.map((c) => c.value), ["reconnect mealie", "reconnect freecad", "reconnect sentry", "reconnect old"]);
    assert.equal(out[1]?.description, "failed (direct)");
  });

  it("narrows servers by the start of their name, ignoring case", () => {
    assert.deepEqual(mcpCompletions("login SE", servers).map((c) => c.value), ["login sentry"]);
  });

  it("has nothing to add after list or an unknown action", () => {
    assert.deepEqual(mcpCompletions("list ", servers), []);
    assert.deepEqual(mcpCompletions("frobnicate ", servers), []);
  });
});
