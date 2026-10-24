import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommandLine } from "../cli.ts";
import { SESSION_COMMANDS, SWITCHER_COMMANDS } from "../commands.ts";

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
