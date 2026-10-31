import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { agentCompletions, agentListing } from "../src/agents-completion.ts";
import { findAgent, loadAgents, mcpWarnings, parseAgent, profileArgs } from "../src/agents.ts";

const FILE = [
  "---",
  "name: explore",
  "description: Read-only look around.",
  "tools: Read, Grep, Glob, mcp__ghidra__*   # claude-style names",
  "model: litellm/gemma4:12b",
  "thinking: low",
  "maxTurns: 25",
  "budget: 150000",
  "---",
  "You explore.",
  "",
].join("\n");

const parse = (text: string) => parseAgent(text, "user", "x.md");

describe("parseAgent", () => {
  it("reads frontmatter and the prompt, mapping Claude-style tool names to pi's", () => {
    const a = parse(FILE);
    assert.equal(a.name, "explore");
    assert.deepEqual(a.tools, ["read", "grep", "find", "mcp__ghidra__*"]);
    assert.equal(a.model, "litellm/gemma4:12b");
    assert.equal(a.maxTurns, 25);
    assert.equal(a.budget, 150000);
    assert.equal(a.prompt, "You explore.");
    assert.deepEqual([a.canSpawn, a.minimal, a.extensions], [false, true, true]);
  });

  it("reads block scalars for long descriptions", () => {
    const a = parse("---\nname: a\ndescription: >\n  first line\n  second line\n---\nbody");
    assert.equal(a.description, "first line second line");
  });

  it("rejects bad files with a message that says what is wrong", () => {
    assert.throws(() => parse("no frontmatter"), /no frontmatter/);
    assert.throws(() => parse("---\ndescription: x\n---\n"), /name is required/);
    assert.throws(() => parse("---\nname: a\n---\n"), /description is required/);
    assert.throws(() => parse("---\nname: a\ndescription: d\nfoo: 1\n---\n"), /unknown key: foo/);
    assert.throws(() => parse("---\nname: a\ndescription: d\nthinking: lots\n---\n"), /thinking must be/);
    assert.throws(() => parse("---\nname: a\ndescription: d\nmodel: gemma\n---\n"), /provider\/id/);
    assert.throws(() => parse("---\nname: a\ndescription: d\nmaxTurns: -1\n---\n"), /positive whole number/);
    assert.throws(() => parse("---\nname: a\ndescription: d\ncanSpawn: maybe\n---\n"), /true or false/);
  });
});

describe("profileArgs", () => {
  it("limits tools and drops MCP unless the profile names an MCP tool", () => {
    const plain = parse("---\nname: a\ndescription: d\ntools: read, grep\n---\nhi");
    const args = profileArgs(plain, { isNew: true });
    assert.deepEqual(args.slice(0, 3), ["--tools", "read,grep", "--no-mcp"]);
    assert.ok(args.includes("--no-context-files"));
    assert.deepEqual(args.slice(-2), ["--append-system-prompt", "hi"]);
    const mcp = profileArgs(parse(FILE), { isNew: true });
    assert.ok(!mcp.includes("--no-mcp"));
  });

  it("sets model and thinking only for a new session", () => {
    const a = parse(FILE);
    const fresh = profileArgs(a, { isNew: true });
    assert.deepEqual([fresh[fresh.indexOf("--model") + 1], fresh[fresh.indexOf("--thinking") + 1]], ["litellm/gemma4:12b", "low"]);
    const resumed = profileArgs(a, { isNew: false });
    assert.ok(!resumed.includes("--model") && !resumed.includes("--thinking"));
  });

  it("changes nothing for a profile that only sets a prompt, apart from the small-prompt defaults", () => {
    const args = profileArgs(parse("---\nname: a\ndescription: d\nminimal: false\n---\n"), { isNew: true });
    assert.deepEqual(args, []);
  });

  it("can turn extensions off", () => {
    const args = profileArgs(parse("---\nname: a\ndescription: d\nextensions: false\nminimal: false\n---\n"), { isNew: true });
    assert.deepEqual(args, ["--no-extensions"]);
  });
});

describe("mcpWarnings", () => {
  it("warns about MCP servers the config lacks, ignoring - versus _", () => {
    const a = parse(FILE);
    assert.deepEqual(mcpWarnings(a, ["mealie"]), ['explore: MCP server "ghidra" is not configured in mcp.json']);
    assert.deepEqual(mcpWarnings(a, ["ghidra"]), []);
    const dashed = parse("---\nname: a\ndescription: d\ntools: mcp__my_srv__*\n---\n");
    assert.deepEqual(mcpWarnings(dashed, ["my-srv"]), []);
  });
});

describe("loadAgents", () => {
  function tree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-agents-"));
    const user = path.join(root, "user");
    const project = path.join(root, "proj");
    fs.mkdirSync(user, { recursive: true });
    fs.mkdirSync(path.join(project, ".toriel", "agents"), { recursive: true });
    return { user, project, env: { TORIEL_AGENTS_DIR: user, HOME: root } };
  }
  const agent = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\nbody`;

  it("lets the project override the user's agent, which overrides the shipped one", () => {
    const t = tree();
    fs.writeFileSync(path.join(t.user, "explore.md"), agent("explore", "user version"));
    fs.writeFileSync(path.join(t.user, "mine.md"), agent("mine", "only mine"));
    fs.writeFileSync(path.join(t.project, ".toriel", "agents", "mine.md"), agent("mine", "project version"));
    const { agents, problems } = loadAgents(t.project, t.env);
    assert.deepEqual(problems, []);
    const by = Object.fromEntries(agents.map((a) => [a.name, a]));
    assert.equal(by.explore?.description, "user version");
    assert.equal(by.explore?.source, "user");
    assert.equal(by.mine?.description, "project version");
    assert.equal(by.mine?.source, "project");
    assert.ok(by.summarize, "shipped agents are included");
    assert.equal(by.summarize?.source, "built-in");
  });

  it("reports a broken file and keeps loading the rest", () => {
    const t = tree();
    fs.writeFileSync(path.join(t.user, "bad.md"), "---\nname: bad\n---\n");
    fs.writeFileSync(path.join(t.user, "good.md"), agent("good", "fine"));
    const { agents, problems } = loadAgents(t.project, t.env);
    assert.ok(agents.some((a) => a.name === "good"));
    assert.equal(problems.length, 1);
    assert.match(problems[0] as string, /bad\.md: description is required/);
  });

  it("findAgent names the choices when there is no such agent", () => {
    const t = tree();
    assert.throws(() => findAgent("nope", t.project, t.env), /no agent called "nope" \(have: explore, summarize\)/);
  });
});

describe("agent completion and listing", () => {
  const agents = [
    { name: "explore", description: "look around" },
    { name: "summarize", description: "digest" },
  ];

  it("completes the name after -a or --agent and keeps the rest of the line", () => {
    assert.deepEqual(agentCompletions("-n foo -a ex", agents), [{ value: "-n foo -a explore", description: "look around" }]);
    assert.deepEqual(agentCompletions("--agent ", agents).map((c) => (c as { value: string }).value), ["--agent explore", "--agent summarize"]);
  });

  it("offers nothing elsewhere on the line", () => {
    assert.deepEqual(agentCompletions("", agents), []);
    assert.deepEqual(agentCompletions("-n foo", agents), []);
    assert.deepEqual(agentCompletions("-a explore -n x", agents), []);
  });

  it("lists agents and problems for /agents", () => {
    const a = parse(FILE);
    const text = agentListing([a], ["f.md: broken"]);
    assert.match(text, /explore\s+Read-only look around/);
    assert.match(text, /tools: read,grep,find,mcp__ghidra__\*/);
    assert.match(text, /Problems:\n {2}f\.md: broken/);
    assert.match(agentListing([], []), /No agent profiles found/);
  });
});
