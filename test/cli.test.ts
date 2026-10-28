import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandName, listing, parseCommandLine, tokenize, usageHint, type CommandSpec } from "../src/cli.ts";

const fork: CommandSpec = {
  name: "fork",
  description: "continue in a copy",
  build: (cmd) => {
    cmd.option("-n, --name <name>", "name for the copy").argument("[prompt...]", "first message");
  },
};
const plain: CommandSpec = { name: "stop", description: "stop it" };
const specs = [fork, plain];

describe("tokenize", () => {
  it("splits on whitespace and groups quoted words", () => {
    assert.deepEqual(tokenize('  a "b c"  \'d e\' f '), ["a", "b c", "d e", "f"]);
  });

  it("lets a backslash escape a space, a quote or a backslash", () => {
    assert.deepEqual(tokenize("my\\ name \\\"x\\\" a\\\\b"), ["my name", '"x"', "a\\b"]);
  });

  it("treats an apostrophe inside a word as a letter, not a quote", () => {
    assert.deepEqual(tokenize("You're the forked session"), ["You're", "the", "forked", "session"]);
  });

  it("opens a quote right after an equals sign", () => {
    assert.deepEqual(tokenize('--name="my fork" x'), ["--name=my fork", "x"]);
  });

  it("keeps a backslash before an ordinary character", () => {
    assert.deepEqual(tokenize("C:\\temp\\x"), ["C:\\temp\\x"]);
  });

  it("keeps an explicitly empty quoted word", () => {
    assert.deepEqual(tokenize('a "" b'), ["a", "", "b"]);
  });

  it("rejects an unterminated quote with advice", () => {
    assert.throws(() => tokenize('say "hello'), /unterminated "/);
  });
});

describe("commandName", () => {
  it("lowercases the first word after the slash", () => {
    assert.equal(commandName("/FORK  hi"), "fork");
    assert.equal(commandName("/skill:demo x"), "skill:demo");
  });
});

describe("parseCommandLine", () => {
  it("runs a command with options and positional words", () => {
    const r = parseCommandLine(specs, '/fork --name "my fork" focus on B');
    assert.equal(r.kind, "run");
    if (r.kind === "run") {
      assert.deepEqual(r.call.args, ["focus", "on", "B"]);
      assert.equal(r.call.opts.name, "my fork");
    }
  });

  it("takes everything after -- as the prompt", () => {
    const r = parseCommandLine(specs, '/fork -- "-10 is the temperature today"');
    assert.equal(r.kind, "run");
    if (r.kind === "run") {
      assert.deepEqual(r.call.args, ["-10 is the temperature today"]);
    }
  });

  it("reports an unknown option and suggests nothing else", () => {
    const r = parseCommandLine(specs, "/fork --bogus x");
    assert.equal(r.kind, "error");
    if (r.kind === "error") {
      assert.match(r.message, /unknown option '--bogus'/);
    }
  });

  it("rejects extra arguments for a command that takes none", () => {
    assert.equal(parseCommandLine(specs, "/stop now").kind, "error");
  });

  it("reports a missing option value", () => {
    const r = parseCommandLine(specs, "/fork --name");
    assert.equal(r.kind, "error");
    if (r.kind === "error") {
      assert.match(r.message, /argument missing/);
    }
  });

  it("reports an unterminated quote as an error rather than running", () => {
    assert.equal(parseCommandLine(specs, '/fork "oops').kind, "error");
  });

  it("answers -h and --help with the generated help", () => {
    for (const flag of ["-h", "--help"]) {
      const r = parseCommandLine(specs, `/fork ${flag}`);
      assert.equal(r.kind, "help");
      if (r.kind === "help") {
        assert.match(r.text, /Usage: \/fork \[options\] \[prompt\.\.\.\]/);
        assert.match(r.text, /-n, --name <name>\s+name for the copy/);
      }
    }
  });

  it("leaves unknown names alone", () => {
    assert.deepEqual(parseCommandLine(specs, "/skill:demo a b"), { kind: "unknown", name: "skill:demo" });
  });
});

describe("usageHint and listing", () => {
  it("derives the hint from the declared options and arguments", () => {
    assert.equal(usageHint(fork), "[options] [prompt...]");
    assert.equal(usageHint(plain), "");
  });

  it("lists every command with its usage and description", () => {
    const text = listing(specs);
    assert.match(text, /\/fork \[options\] \[prompt\.\.\.\]\s+continue in a copy/);
    assert.match(text, /\/stop\s+stop it/);
    assert.match(text, /--help/);
  });
});

describe("omitted optional arguments", () => {
  it("are left out of the argument list, never the text 'undefined'", () => {
    const spec = { name: "x", description: "d", build: (cmd) => cmd.argument("[a]", "first").argument("[b]", "second") } satisfies CommandSpec;
    const r = parseCommandLine([spec], "/x one");
    assert.equal(r.kind, "run");
    assert.deepEqual(r.kind === "run" ? r.call.args : null, ["one"]);
  });
});
