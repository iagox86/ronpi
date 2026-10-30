import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addMcpServer, mcpCompletions, mcpEntry, mcpListLines, mcpServerConnected, parseMcpStatus, removeMcpServer, skillForServer } from "../src/mcp.ts";

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
    assert.deepEqual(mcpCompletions("", servers).map((c) => c.value), ["list", "status ", "explore ", "add ", "remove ", "reconnect ", "login ", "logout "]);
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

  it("offers the servers after explore, like the other per-server actions", () => {
    assert.deepEqual(mcpCompletions("explore fr", servers).map((c) => c.value), ["explore freecad"]);
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

describe("removeMcpServer", () => {
  function tmpFile(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-mcp-"));
    const file = path.join(dir, "mcp.json");
    fs.writeFileSync(file, content);
    return file;
  }

  it("removes one server and keeps the others and every other key", () => {
    const file = tmpFile(JSON.stringify({ settings: { t: 1 }, mcpServers: { a: { command: "a" }, b: { url: "http://b/mcp" } } }));
    removeMcpServer(file, "a");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { settings: { t: 1 }, mcpServers: { b: { url: "http://b/mcp" } } });
  });

  it("says where a server is defined when it is not in this file", () => {
    const user = tmpFile(JSON.stringify({ mcpServers: { a: { command: "a" } } }));
    const project = tmpFile(JSON.stringify({ mcpServers: { proj: { command: "p" } } }));
    assert.throws(() => removeMcpServer(user, "proj", [project]), new RegExp(`defined in ${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.throws(() => removeMcpServer(user, "ghost", [project]), /not in .*extension cannot be removed/);
    assert.throws(() => removeMcpServer(path.join(os.tmpdir(), "no-such-ronpi-mcp.json"), "a"), /is not in/);
  });

  it("leaves a file that is not valid JSON alone", () => {
    const file = tmpFile("{ nope");
    assert.throws(() => removeMcpServer(file, "a"), /not valid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ nope");
  });

  it("offers server names after remove, with their state", () => {
    const out = mcpCompletions("remove me", [{ name: "mealie", detail: "connected, 12 tools (direct)" }, { name: "other", detail: "x" }]);
    assert.deepEqual(out, [{ value: "remove mealie", description: "connected, 12 tools (direct)" }]);
  });
});

describe("skillForServer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-skills-"));
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("names the matching skill directory, by SKILL.md or directory name, ignoring case", () => {
    fs.mkdirSync(path.join(dir, "recipe-import"), { recursive: true });
    fs.writeFileSync(path.join(dir, "recipe-import", "SKILL.md"), "# import recipes into the Mealie server\n");
    fs.mkdirSync(path.join(dir, "vikunja-mcp"), { recursive: true });
    fs.writeFileSync(path.join(dir, "vikunja-mcp", "SKILL.md"), "# a skill that mentions nothing else\n");
    fs.mkdirSync(path.join(dir, "other"), { recursive: true });
    fs.writeFileSync(path.join(dir, "other", "SKILL.md"), "# unrelated\n");
    assert.equal(skillForServer([dir], "mealie"), "recipe-import");
    assert.equal(skillForServer([dir], "MEALIE"), "recipe-import");
    assert.equal(skillForServer([dir], "vikunja"), "vikunja-mcp");
    assert.equal(skillForServer([dir], "nope"), undefined);
  });

  it("treats a missing skills dir as no skills at all", () => {
    assert.equal(skillForServer([path.join(dir, "gone")], "mealie"), undefined);
  });

  it("matches the server name as a whole word in SKILL.md, not inside longer words", () => {
    fs.mkdirSync(path.join(dir, "spelling"), { recursive: true });
    fs.writeFileSync(path.join(dir, "spelling", "SKILL.md"), "# about digits, not version control\n");
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "SKILL.md"), "# use git for version control\n");
    assert.equal(skillForServer([dir], "git"), "tools");
    fs.rmSync(path.join(dir, "tools"), { recursive: true });
    assert.equal(skillForServer([dir], "git"), undefined);
  });

  it("scans extension-provided skills roots too, earlier dirs first", () => {
    // the real layout: ~/.pi/agent/skills plus ~/.pi/agent/<extension>/skills
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-agent-"));
    fs.mkdirSync(path.join(root, "skills", "other-vikunja-skill"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "other-vikunja-skill", "SKILL.md"), "# unrelated\n");
    fs.mkdirSync(path.join(root, "pi-hermes-memory", "skills", "vikunja-mcp"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "pi-hermes-memory", "skills", "vikunja-mcp", "SKILL.md"),
      "# the vikunja job board workflow\n",
    );
    const dirs = [path.join(root, "skills"), path.join(root, "pi-hermes-memory", "skills")];
    assert.equal(skillForServer(dirs, "vikunja"), "other-vikunja-skill");
    assert.equal(skillForServer([path.join(root, "pi-hermes-memory", "skills")], "vikunja"), "vikunja-mcp");
  });
});

describe("mcpListLines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-list-skills-"));
  fs.mkdirSync(path.join(dir, "recipe-import"), { recursive: true });
  fs.writeFileSync(path.join(dir, "recipe-import", "SKILL.md"), "# import recipes into the Mealie server\n");
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends the skill to every server line and passes non-server lines through", () => {
    assert.deepEqual(mcpListLines(STATUS, [dir]), [
      "mealie: connected, 12 tools (direct) - skill: recipe-import",
      "freecad: failed (direct) - no matching skill (/mcp explore freecad)",
      "    connect ECONNREFUSED 127.0.0.1:39280",
      "sentry: needs sign-in, run /mcp login sentry (direct) - no matching skill (/mcp explore sentry)",
      "old: disabled (direct) - no matching skill (/mcp explore old)",
      "config error: bad.json is not valid JSON",
      "overridden: docs (project entry wins)",
    ]);
  });

  it("keeps the whole state text and points at /mcp explore when no skills exist", () => {
    assert.deepEqual(mcpListLines("mealie: connected, 12 tools (direct)", []), [
      "mealie: connected, 12 tools (direct) - no matching skill (/mcp explore mealie)",
    ]);
  });

  it("passes the none-configured message through untouched", () => {
    const none = "No MCP servers configured. Add them to /x/mcp.json or .pi/mcp.json.";
    assert.deepEqual(mcpListLines(none, [dir]), [none]);
  });
});

describe("mcpServerConnected", () => {
  it("is true only for a server listed as connected", () => {
    assert.equal(mcpServerConnected(STATUS, "mealie"), true);
    assert.equal(mcpServerConnected(STATUS, "freecad"), false);
    assert.equal(mcpServerConnected(STATUS, "sentry"), false);
    assert.equal(mcpServerConnected(STATUS, "nosuch"), false);
  });
});
