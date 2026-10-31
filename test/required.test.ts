import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { REQUIRED, TORIEL_TOOLS, auditRequired, describeProblems } from "../src/required.ts";

function agentDir(present: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-req-"));
  for (const rel of present) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "");
  }
  return dir;
}

describe("auditRequired", () => {
  it("reports nothing when every required resource is linked", () => {
    const dir = agentDir(REQUIRED.map((r) => `${r.kind}/${r.name}`));
    assert.deepEqual(auditRequired(dir), []);
    assert.equal(describeProblems([]), undefined);
  });

  it("names each missing resource and the fix", () => {
    const dir = agentDir(["extensions/toriel-presence.ts"]);
    const problems = auditRequired(dir);
    assert.ok(problems.every((p) => p.item.name !== "toriel-presence.ts"));
    const text = describeProblems(problems) ?? "";
    assert.match(text, /toriel-session-bridge\.ts \(missing\)/);
    assert.match(text, /node src\/install\.ts/);
  });

  it("tells a dangling link from a missing file", () => {
    const dir = agentDir([]);
    fs.mkdirSync(path.join(dir, "extensions"));
    fs.symlinkSync(path.join(dir, "nowhere"), path.join(dir, "extensions", "toriel-usage.ts"));
    const usage = auditRequired(dir).find((p) => p.item.name === "toriel-usage.ts");
    assert.equal(usage?.state, "dangling");
  });
});

describe("TORIEL_TOOLS", () => {
  it("is the + modifier of every tool a required extension registers", () => {
    assert.deepEqual([...TORIEL_TOOLS], ["+toriel_message", "+toriel_usage"]);
  });
});
