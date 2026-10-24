import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { lineageArgs, loadLineage, recordFork } from "../lineage.ts";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ronpi-lineage-")), "lineage.json");
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
});
