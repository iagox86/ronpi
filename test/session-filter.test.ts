import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommandLine } from "../src/cli.ts";
import { SWITCHER_COMMANDS } from "../src/commands.ts";
import { compileFilter } from "../src/session-filter.ts";
import type { SwitcherSession } from "../src/switcher.ts";

const row = (over: Partial<SwitcherSession>): SwitcherSession => ({ key: "/a", name: "n", state: "idle", ...over });

describe("session filter on comments", () => {
  it("finds a session by its hidden comment", () => {
    const f = compileFilter("vendor friday", false);
    assert.ok(f?.test(row({ name: "import", comment: "waiting on the vendor, retry friday" })));
    assert.equal(f?.test(row({ name: "import" })), false);
  });
});

describe("session filter", () => {
  const login = row({ name: "Login work", description: "fixing the auth bug", group: "Work", model: "glm-5.3", cwd: "/src/webapp" });
  const notes = row({ name: "Meeting notes", description: "weekly sync", cwd: "/home/ron/notes" });

  it("matches rows containing every word, in any column, ignoring case", () => {
    const f = compileFilter("AUTH work", false)!;
    assert.equal(f.test(login), true);
    assert.equal(f.test(notes), false);
    assert.equal(compileFilter("webapp glm", false)!.test(login), true);
  });

  it("treats a regex query as one case-insensitive pattern", () => {
    const f = compileFilter("^login|sync$", true)!;
    assert.equal(f.test(notes), false, "the pattern runs over the joined row text, so $ is the end of all of it");
    assert.equal(compileFilter("auth.*bug", true)!.test(login), true);
    assert.equal(compileFilter("LOGIN", true)!.test(login), true);
  });

  it("matches a group by its own name, so an empty group can still be found", () => {
    assert.equal(compileFilter("infra", false)!.testGroup("Infrastructure"), true);
    assert.equal(compileFilter("infra", false)!.testGroup("Work"), false);
    assert.equal(compileFilter("^inf", true)!.testGroup("Infrastructure"), true);
  });

  it("is no filter for an empty query, and rejects an invalid pattern", () => {
    assert.equal(compileFilter("   ", false), null);
    assert.throws(() => compileFilter("[unclosed", true));
  });
});

describe("/filter command line", () => {
  const parse = (line: string) => {
    const r = parseCommandLine(SWITCHER_COMMANDS, line);
    return r.kind === "run" ? r.call : undefined;
  };

  it("takes words, with --regex or -r switching to a pattern", () => {
    assert.deepEqual(parse("/filter auth bug")?.args, ["auth", "bug"]);
    assert.equal(parse("/filter --regex a.b")?.opts.regex, true);
    assert.equal(parse("/filter -r a.b")?.opts.regex, true);
    assert.equal(parse("/filter")?.args.length, 0);
  });
});
