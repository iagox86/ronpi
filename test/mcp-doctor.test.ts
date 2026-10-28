import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adviceFor, type Checks, describeEntry, parseStatusDetailed, probeEntry, statusReport } from "../src/mcp-doctor.ts";

const STATUS = [
  "mealie: connected, 12 tools (direct)",
  "freecad: failed (direct)",
  "    connect ECONNREFUSED 127.0.0.1:39280",
  "sentry: needs sign-in, run /mcp login sentry (direct)",
  "old: disabled (direct)",
  "config error: bad.json is not valid JSON",
].join("\n");

const checks = (over: Partial<Checks> = {}): Checks => ({ onPath: () => true, executable: () => true, reachable: async () => true, ...over });

describe("parseStatusDetailed", () => {
  it("keeps the error lines under each server and the config errors apart", () => {
    const p = parseStatusDetailed(STATUS);
    assert.deepEqual(p.servers.map((s) => s.name), ["mealie", "freecad", "sentry", "old"]);
    assert.deepEqual(p.servers[1]?.notes, ["connect ECONNREFUSED 127.0.0.1:39280"]);
    assert.deepEqual(p.configErrors, ["bad.json is not valid JSON"]);
  });
});

describe("describeEntry", () => {
  it("shows how a server starts but never secret values", () => {
    const lines = describeEntry({
      command: "podman",
      args: ["run", "-i", "--token", "SECRET1", "--api-key=SECRET2", "-e", "X", "image"],
      env: { MEALIE_API_TOKEN: "SECRET3" },
      headers: { Authorization: "Bearer SECRET4" },
    });
    const text = lines.join("\n");
    assert.match(text, /command: podman run -i --token \*\*\* --api-key=\*\*\* -e X image/);
    assert.match(text, /env: MEALIE_API_TOKEN \(values hidden\)/);
    assert.match(text, /headers: Authorization \(values hidden\)/);
    assert.doesNotMatch(text, /SECRET/);
  });

  it("hides credentials inside a URL", () => {
    assert.equal(describeEntry({ url: "https://user:pw@host/mcp?api_token=abc&x=1" })[0], "url: https://***@host/mcp?api_token=***&x=1");
  });
});

describe("probeEntry", () => {
  it("reports a command that is not installed", async () => {
    const f = await probeEntry({ command: "ghidra-mcp" }, checks({ onPath: () => false }));
    assert.match(f[0] ?? "", /"ghidra-mcp" was not found on the PATH/);
    assert.deepEqual(await probeEntry({ command: "ghidra-mcp" }, checks()), []);
  });

  it("checks a full path as a file and expands ~", async () => {
    const seen: string[] = [];
    await probeEntry({ command: "~/bin/x" }, checks({ executable: (f) => (seen.push(f), false) }), "/home/u");
    assert.deepEqual(seen, ["/home/u/bin/x"]);
  });

  it("reports a URL nothing answers at, with the port it tried", async () => {
    const f = await probeEntry({ url: "http://127.0.0.1:39280/mcp" }, checks({ reachable: async () => false }));
    assert.match(f[0] ?? "", /127\.0\.0\.1:39280/);
    const https = await probeEntry({ url: "https://example.com/mcp" }, checks({ reachable: async (_h, p) => p === 443 }));
    assert.deepEqual(https, []);
  });

  it("rejects an entry that has nothing to start and a URL that is not one", async () => {
    assert.match((await probeEntry({}, checks()))[0] ?? "", /neither a command nor a url/);
    assert.match((await probeEntry({ url: "not a url" }, checks()))[0] ?? "", /not a valid URL/);
  });
});

describe("adviceFor", () => {
  const status = (detail: string, ...notes: string[]) => ({ name: "x", detail, notes });

  it("points at the right fix for the usual causes", () => {
    assert.match(adviceFor(status("needs sign-in (direct)"), undefined).join("\n"), /\/mcp login x/);
    assert.match(adviceFor(status("failed (direct)", "connect ECONNREFUSED 1.2.3.4:80"), undefined).join("\n"), /could not be reached/);
    assert.match(adviceFor(status("failed (direct)", "spawn podman ENOENT"), undefined).join("\n"), /could not be run/);
    assert.match(adviceFor(status("disabled (direct)"), { enabled: false }).join("\n"), /"enabled": true/);
  });

  it("falls back to reading the error and reconnecting", () => {
    const out = adviceFor(status("failed (direct)", "something odd"), undefined).join("\n");
    assert.match(out, /read the error above/);
    assert.match(out, /\/mcp reconnect x/);
  });
});

describe("statusReport", () => {
  const parsed = parseStatusDetailed(STATUS);
  const configs = new Map([["freecad", { entry: { url: "http://127.0.0.1:39280/mcp" }, file: "/home/u/.pi/agent/mcp.json" }]]);

  it("summarises, marks sick servers, and shows error, configuration, checks and advice", () => {
    const text = statusReport(parsed, configs, new Map([["freecad", ["nothing is accepting connections at 127.0.0.1:39280"]]]));
    assert.match(text, /MCP status: 1 of 4 connected/);
    assert.match(text, /OK {2}mealie: connected/);
    assert.match(text, /!! {2}freecad: failed \(direct\)\n {6}connect ECONNREFUSED/);
    assert.match(text, /configured in \/home\/u\/\.pi\/agent\/mcp\.json/);
    assert.match(text, /check: nothing is accepting connections/);
    assert.match(text, /try: the server could not be reached/);
    assert.match(text, /Config problems:\n {2}bad\.json is not valid JSON/);
    assert.match(text, /sentry: needs sign-in[\s\S]*try: sign in: \/mcp login sentry/);
  });

  it("limits the report to the server asked about and says when there is no such server", () => {
    const one = statusReport(parsed, configs, new Map(), "freecad");
    assert.match(one, /MCP status: 0 of 1 connected/);
    assert.doesNotMatch(one, /mealie/);
    assert.match(statusReport(parsed, configs, new Map(), "XYZ"), /No server called XYZ/);
  });

  it("says what to do when nothing is configured", () => {
    assert.match(statusReport({ servers: [], configErrors: [] }, new Map(), new Map()), /\/mcp add/);
  });
});
