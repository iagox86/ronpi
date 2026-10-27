import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommandLine } from "../src/cli.ts";
import { SESSION_COMMANDS, SWITCHER_COMMANDS } from "../src/commands.ts";

describe("command registries", () => {
  for (const [label, specs] of [
    ["switcher", SWITCHER_COMMANDS],
    ["session", SESSION_COMMANDS],
  ] as const) {
    it(`gives every ${label} command working -h and --help`, () => {
      for (const spec of specs) {
        for (const flag of ["-h", "--help"]) {
          const r = parseCommandLine(specs, `/${spec.name} ${flag}`);
          assert.equal(r.kind, "help", `/${spec.name} ${flag}`);
          if (r.kind === "help") {
            assert.match(r.text, new RegExp(`^Usage: /${spec.name}\\b`));
            assert.ok(r.text.includes(spec.description.slice(0, 20)), `/${spec.name} help shows its description`);
          }
        }
      }
    });

    it(`has unique ${label} command names`, () => {
      const names = specs.map((c) => c.name);
      assert.equal(new Set(names).size, names.length);
    });
  }
});

describe("/fork flags", () => {
  const opts = (line: string) => {
    const r = parseCommandLine(SESSION_COMMANDS, line);
    return r.kind === "run" ? r.call.opts : undefined;
  };

  it("enters the copy unless --no-switch is given", () => {
    assert.equal(opts("/fork go")?.switch, true);
    assert.equal(opts("/fork --no-switch go")?.switch, false);
  });
});

describe("command flags", () => {
  const opts = (specs: Parameters<typeof parseCommandLine>[0], line: string) => {
    const r = parseCommandLine(specs, line);
    return r.kind === "run" ? r.call.opts : undefined;
  };

  it("lets /new take a name and a working directory", () => {
    assert.deepEqual(opts(SWITCHER_COMMANDS, "/new -n work -C /tmp"), { name: "work", cwd: "/tmp" });
  });

  it("lets /delete skip its confirmation with -y", () => {
    assert.equal(opts(SWITCHER_COMMANDS, "/delete -y")?.yes, true);
    assert.equal(opts(SWITCHER_COMMANDS, "/delete")?.yes, undefined);
  });

  it("lets /model list everything with --list", () => {
    assert.equal(opts(SESSION_COMMANDS, "/model --list")?.list, true);
    assert.equal(opts(SESSION_COMMANDS, "/model -l")?.list, true);
  });

  it("has /ungroup in the switcher", () => {
    assert.equal(parseCommandLine(SWITCHER_COMMANDS, "/ungroup").kind, "run");
  });
});
