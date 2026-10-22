import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommand } from "../commands.ts";

describe("parseCommand", () => {
  it("splits the command name from its argument", () => {
    assert.deepEqual(parseCommand("/rename my new name"), { name: "rename", arg: "my new name" });
  });

  it("lowercases the name and tolerates no argument", () => {
    assert.deepEqual(parseCommand("/KILL"), { name: "kill", arg: "" });
  });

  it("collapses runs of whitespace in the argument", () => {
    assert.deepEqual(parseCommand("/group   a   b "), { name: "group", arg: "a b" });
  });
});
