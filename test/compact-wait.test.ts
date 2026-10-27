import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CompactingChild, compactAndWait } from "../src/compact-wait.ts";

const TIMEOUT = new Error("Timeout waiting for response to compact. Stderr: ");

function child(compact: () => Promise<never>, endEvent?: object): CompactingChild {
  let listener: (e: unknown) => void = () => {};
  return {
    onEvent: (l) => {
      listener = l;
      return () => {};
    },
    compact: async () => {
      if (endEvent) {
        setTimeout(() => listener(endEvent), 5);
      }
      return compact();
    },
  };
}

describe("compactAndWait", () => {
  it("returns pi's reply when it arrives in time", async () => {
    const c: CompactingChild = { onEvent: () => () => {}, compact: async () => ({ tokensBefore: 9 }) };
    assert.deepEqual(await compactAndWait(c, undefined), { tokensBefore: 9 });
  });

  it("waits for compaction_end when the client's reply timeout fires first", async () => {
    const c = child(() => Promise.reject(TIMEOUT), { type: "compaction_end", result: { tokensBefore: 120 } });
    assert.deepEqual(await compactAndWait(c, undefined), { tokensBefore: 120 });
  });

  it("reports a compaction that failed while we waited", async () => {
    const c = child(() => Promise.reject(TIMEOUT), { type: "compaction_end", errorMessage: "Compaction failed: boom" });
    await assert.rejects(compactAndWait(c, undefined), /Compaction failed: boom/);
  });

  it("passes other errors straight through", async () => {
    const c = child(() => Promise.reject(new Error("no model")));
    await assert.rejects(compactAndWait(c, undefined), /no model/);
  });

  it("gives up if compaction never finishes", async () => {
    const c = child(() => Promise.reject(TIMEOUT));
    await assert.rejects(compactAndWait(c, undefined, 20), /timed out waiting/);
  });
});
