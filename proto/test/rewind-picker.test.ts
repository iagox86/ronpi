import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RewindPicker } from "../rewind-picker.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const targets = (n: number) => Array.from({ length: n }, (_, i) => ({ entryId: `e${i}`, text: `message ${i}`, ts: i }));

describe("rewind picker", () => {
  it("draws nothing while closed", () => {
    assert.deepEqual(new RewindPicker().render(80), []);
  });

  it("starts on the newest message and moves toward older ones", () => {
    const p = new RewindPicker();
    p.open(targets(3));
    assert.equal(p.current()?.entryId, "e2");
    p.move(-1);
    assert.equal(p.current()?.entryId, "e1");
    p.move(-5);
    assert.equal(p.current()?.entryId, "e0", "clamps at the oldest");
  });

  it("marks the selection and warns that files are not restored", () => {
    const p = new RewindPicker();
    p.open(targets(3));
    const out = p.render(100).map((l) => strip(l).trim());
    assert.ok(out.some((l) => /file changes are not undone/.test(l)));
    assert.ok(out.some((l) => l.startsWith("> message 2")));
  });

  it("windows long histories and says how many are scrolled off", () => {
    const p = new RewindPicker();
    p.open(targets(30));
    const out = p.render(100).map(strip);
    assert.ok(out.length <= 15);
    assert.ok(out.some((l) => /\.\.\. \d+ earlier/.test(l)));
    assert.ok(out.some((l) => l.includes("message 29")));
  });

  it("closes", () => {
    const p = new RewindPicker();
    p.open(targets(2));
    p.close();
    assert.equal(p.isOpen, false);
  });
});

describe("rewind picker and compaction", () => {
  it("labels messages from before a compaction and warns when one is selected", () => {
    const p = new RewindPicker();
    p.open([
      { entryId: "e0", text: "old", ts: 0, compacted: true },
      { entryId: "e1", text: "new", ts: 1 },
    ]);
    p.move(-1);
    const text = p.render(120).map(strip).join("\n");
    assert.match(text, /old \[before a compaction\]/);
    assert.match(text, /also undoes the compaction/);
    p.move(1);
    assert.doesNotMatch(p.render(120).map(strip).join("\n"), /also undoes the compaction/);
  });
});
