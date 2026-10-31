import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { detachFromParent, lineageArgs, loadLineage, recordFork } from "../src/lineage.ts";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-lineage-")), "lineage.json");
const ref = (id: string, name = id) => ({ id, name, file: `/s/${id}.jsonl` });

describe("lineage", () => {
  it("tells a fork about its parent", () => {
    const file = tmp();
    recordFork(ref("p", "Parent"), ref("c", "Child"), file);
    const [flag, text] = lineageArgs("c", file);
    assert.equal(flag, "--append-system-prompt");
    assert.match(text as string, /fork of the session "Parent" \(session id p, file \/s\/p\.jsonl\)/);
  });

  it("does not tell a parent about its forks, but still records them", () => {
    const file = tmp();
    recordFork(ref("p"), ref("c1"), file);
    recordFork(ref("p"), ref("c2"), file);
    assert.deepEqual(lineageArgs("p", file), []);
    assert.deepEqual(loadLineage(file).p?.forks?.map((f) => f.id), ["c1", "c2"]);
  });

  it("says nothing for a session with no lineage", () => {
    assert.deepEqual(lineageArgs("nobody", tmp()), []);
    assert.deepEqual(lineageArgs(undefined, tmp()), []);
  });

  it("detaches a fork from its parent in both directions and stops telling it who its parent was", () => {
    const file = tmp();
    recordFork(ref("p", "Parent"), ref("c1", "One"), file);
    recordFork(ref("p", "Parent"), ref("c2", "Two"), file);
    assert.equal(detachFromParent("c1", file)?.name, "Parent");
    const after = loadLineage(file);
    assert.equal(after.c1, undefined);
    assert.deepEqual(after.p?.forks?.map((f) => f.id), ["c2"]);
    assert.equal(after.c2?.parent?.id, "p");
    assert.deepEqual(lineageArgs("c1", file), []);
  });

  it("keeps the rest of an entry that is also a parent, and does nothing for a session without one", () => {
    const file = tmp();
    recordFork(ref("p"), ref("c"), file);
    recordFork(ref("c"), ref("g"), file);
    detachFromParent("c", file);
    const after = loadLineage(file);
    assert.deepEqual(after.c?.forks?.map((f) => f.id), ["g"]);
    assert.equal(after.c?.parent, undefined);
    assert.equal(after.p, undefined, "a parent with no children left has no entry");
    assert.equal(detachFromParent("p", file), undefined);
    assert.equal(detachFromParent("unknown", file), undefined);
  });
});
