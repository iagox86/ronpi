import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summaryLine, type ToolCall, ToolRun, toolNames } from "../tool-run.ts";

const call = (name: string, failed = false, lines = ["full block"]): ToolCall =>
  ({ name, failed, component: { render: () => lines, invalidate() {}, setExpanded() {} } }) as unknown as ToolCall;

describe("tool run", () => {
  it("counts calls by name in first-seen order", () => {
    assert.equal(toolNames([call("bash"), call("read"), call("bash")]), "bash x2, read");
  });

  it("collapses to one line and flags failures", () => {
    const run = new ToolRun();
    run.calls.push(call("bash", true), call("read"));
    const out = run.render(120);
    assert.equal(out.length, 1);
    assert.match(out[0] as string, /2 tool calls: bash, read/);
    assert.match(out[0] as string, /1 failed/);
    assert.match(summaryLine([call("ls")]), /1 tool call:/);
  });

  it("mentions ctrl-o only when it is the hinted run", () => {
    const run = new ToolRun();
    run.calls.push(call("bash"));
    assert.match(run.render(120)[0] as string, /ctrl-o to expand/);
    run.showHint = false;
    assert.doesNotMatch(run.render(120)[0] as string, /ctrl-o/);
  });

  it("expands to every call's full block", () => {
    const run = new ToolRun();
    run.calls.push(call("a", false, ["a1", "a2"]), call("b", false, ["b1"]));
    run.expanded = true;
    assert.deepEqual(run.render(80), ["a1", "a2", "b1"]);
  });
});
