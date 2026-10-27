import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addMcpServer, mcpCompletions, mcpEntry, parseMcpStatus } from "../mcp.ts";

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
    assert.deepEqual(mcpCompletions("", servers).map((c) => c.value), ["list", "add ", "reconnect ", "login ", "logout "]);
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

describe("mcpEntry", () => {
  it("treats a URL as a remote server", () => {
    assert.deepEqual(mcpEntry(["http://127.0.0.1:1/mcp"]), { url: "http://127.0.0.1:1/mcp" });
  });

  it("treats anything else as a command with its arguments", () => {
    assert.deepEqual(mcpEntry(["npx", "-y", "pkg"]), { command: "npx", args: ["-y", "pkg"] });
    assert.deepEqual(mcpEntry(["server"]), { command: "server" });
  });

  it("rejects an empty target and a URL with extra words", () => {
    assert.throws(() => mcpEntry([]), /URL or a command/);
    assert.throws(() => mcpEntry(["https://x/mcp", "extra"]), /no further/);
  });
});

describe("addMcpServer", () => {
  function tmpFile(content?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-mcp-"));
    const file = path.join(dir, "mcp.json");
    if (content !== undefined) {
      fs.writeFileSync(file, content);
    }
    return file;
  }

  it("creates the file when there is none", () => {
    const file = tmpFile();
    addMcpServer(file, "a", { url: "http://x/mcp" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { mcpServers: { a: { url: "http://x/mcp" } } });
  });

  it("keeps existing servers and other keys", () => {
    const file = tmpFile(JSON.stringify({ settings: { t: 1 }, mcpServers: { old: { command: "o" } } }));
    addMcpServer(file, "new", { command: "n" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      settings: { t: 1 },
      mcpServers: { old: { command: "o" }, new: { command: "n" } },
    });
  });

  it("refuses to replace a server or to rewrite a file that is not JSON", () => {
    const file = tmpFile(JSON.stringify({ mcpServers: { a: { command: "o" } } }));
    assert.throws(() => addMcpServer(file, "a", { command: "n" }), /already exists/);
    const bad = tmpFile("{ nope");
    assert.throws(() => addMcpServer(bad, "a", { command: "n" }), /not valid JSON/);
    assert.equal(fs.readFileSync(bad, "utf8"), "{ nope");
  });
});
