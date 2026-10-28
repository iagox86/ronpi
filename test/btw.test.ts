import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { askBtw, btwArgs, btwPrompt, saveBtw } from "../src/btw.ts";

function stubPi(dir: string, body: string): string {
  const file = path.join(dir, "pi.mjs");
  fs.writeFileSync(file, body);
  return file;
}

describe("btw", () => {
  it("tells the model it has no tools and cannot be answered", () => {
    const p = btwPrompt("why did you pick sqlite?");
    assert.match(p, /no tools/);
    assert.match(p, /do not ask follow-up questions/);
    assert.match(p, /Question: why did you pick sqlite\?/);
  });

  it("runs pi without tools or extensions on a copy of the session", () => {
    const args = btwArgs("/pi/cli.js", "/tmp/copy.jsonl", "q", "litellm/gemma4:12b");
    assert.deepEqual(args.slice(0, 2), ["/pi/cli.js", "--print"]);
    assert.ok(args.includes("--no-tools") && args.includes("--no-extensions"));
    assert.equal(args[args.indexOf("--session") + 1], "/tmp/copy.jsonl");
    assert.equal(args[args.indexOf("--model") + 1], "litellm/gemma4:12b");
    assert.equal(args.at(-1), "q");
    assert.ok(!btwArgs("/pi/cli.js", "/c", "q").includes("--model"));
  });

  it("returns pi's answer and leaves the original session file untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btw-test-"));
    try {
      const session = path.join(dir, "s.jsonl");
      fs.writeFileSync(session, '{"type":"session"}\n');
      // the stub appends to the session it is given, like pi would, and echoes the file it was given
      const cli = stubPi(dir, `import fs from "node:fs"; const f = process.argv[process.argv.indexOf("--session") + 1]; fs.appendFileSync(f, "x\\n"); console.log("answer for " + f.split("/").pop());\n`);
      const answer = await askBtw({ piCli: cli, file: session, question: "q" });
      assert.equal(answer, "answer for s.jsonl");
      assert.equal(fs.readFileSync(session, "utf8"), '{"type":"session"}\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports pi's error text when it fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btw-test-"));
    try {
      const session = path.join(dir, "s.jsonl");
      fs.writeFileSync(session, "\n");
      const cli = stubPi(dir, `console.error("model not found"); process.exit(2);\n`);
      await assert.rejects(askBtw({ piCli: cli, file: session, question: "q" }), /exited with 2: model not found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves an answer as markdown with the question as its title", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "btw-test-"));
    try {
      const file = saveBtw("why?", "because", dir, new Date("2026-01-02T03:04:05Z"));
      assert.match(path.basename(file), /^btw-2026-01-02T03-04-05-000Z\.md$/);
      assert.equal(fs.readFileSync(file, "utf8"), "# why?\n\nbecause\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
