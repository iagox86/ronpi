import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ActivityState, activityLines, formatElapsed, reduceActivity } from "../activity.ts";

const fresh = (): ActivityState => ({ queue: [] });

describe("activity", () => {
  it("follows a run from start through tool use to settled", () => {
    const s = fresh();
    reduceActivity(s, { type: "agent_start" }, 1000);
    assert.equal(s.activity?.label, "working");
    reduceActivity(s, { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }, 2000);
    assert.equal(s.activity?.label, "thinking");
    reduceActivity(s, { type: "tool_execution_start", toolName: "bash" }, 3000);
    assert.equal(s.activity?.label, "running bash");
    reduceActivity(s, { type: "message_update", assistantMessageEvent: { type: "text_delta" } }, 4000);
    assert.equal(s.activity?.label, "writing");
    assert.equal(s.activity?.since, 1000, "elapsed counts from the start of the run, not the phase");
    reduceActivity(s, { type: "agent_settled" }, 5000);
    assert.equal(s.activity, undefined);
  });

  it("shows retry and compaction as activity, not a hang", () => {
    const s = fresh();
    reduceActivity(s, { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000 }, 0);
    assert.equal(s.activity?.label, "retrying (2/3) in 4s");
    reduceActivity(s, { type: "compaction_start" }, 0);
    assert.equal(s.activity?.label, "compacting context");
  });

  it("stops showing activity when a manual compaction ends, but not an automatic one", () => {
    const manual = fresh();
    reduceActivity(manual, { type: "compaction_start" }, 0);
    reduceActivity(manual, { type: "compaction_end", reason: "manual" }, 5);
    assert.equal(manual.activity, undefined);
    const auto = fresh();
    reduceActivity(auto, { type: "compaction_start" }, 0);
    reduceActivity(auto, { type: "compaction_end", reason: "threshold" }, 5);
    assert.equal(auto.activity?.label, "working");
  });

  it("replaces the queue wholesale on each queue_update", () => {
    const s = fresh();
    reduceActivity(s, { type: "queue_update", steering: ["a", "b"], followUp: [] }, 0);
    assert.deepEqual(s.queue, ["a", "b"]);
    reduceActivity(s, { type: "queue_update", steering: [], followUp: [] }, 0);
    assert.deepEqual(s.queue, []);
  });

  it("lists queued messages above the spinner line, capped", () => {
    const s: ActivityState = { queue: ["one", "two", "three", "four"], activity: { label: "thinking", since: 0 } };
    const lines = activityLines(s, 80, 65_000);
    assert.equal(lines.length, 5);
    assert.match(lines[0] as string, /queued: one/);
    assert.match(lines[3] as string, /\+1 more/);
    assert.match(lines[4] as string, /thinking.*1m05s/);
  });

  it("draws nothing when idle with an empty queue", () => {
    assert.deepEqual(activityLines(fresh(), 80, 0), []);
  });

  it("formats elapsed time", () => {
    assert.equal(formatElapsed(9_400), "9s");
    assert.equal(formatElapsed(125_000), "2m05s");
  });
});
