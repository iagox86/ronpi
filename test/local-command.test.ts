import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanOutput, formatLocalCommand, HEAD_CHARS, parseLocalCommand, runLocal, TAIL_CHARS, truncateOutput } from "../src/local-command.ts";

describe("local command message", () => {
  const result = { output: "root:x:0:0\n", exitCode: 0, cancelled: false, truncated: false };

  it("round-trips the command, output and exit code", () => {
    const parsed = parseLocalCommand(formatLocalCommand("cat /etc/passwd", result));
    assert.deepEqual(parsed, { command: "cat /etc/passwd", output: "root:x:0:0\n", exitCode: 0, cancelled: false });
  });

  it("tells the agent that the user ran it and it is not pasted text", () => {
    const text = formatLocalCommand("ls", result);
    assert.match(text, /<local-command-caveat>.*did not run it and it is not pasted text/);
    assert.match(text, /<local-command-output exit="0">/);
  });

  it("marks a cancelled command and keeps output that mentions the closing tag", () => {
    const tricky = { output: "x </local-command-output> y", exitCode: undefined, cancelled: true, truncated: false };
    const parsed = parseLocalCommand(formatLocalCommand("sleep 9", tricky));
    assert.deepEqual([parsed?.cancelled, parsed?.exitCode, parsed?.output], [true, undefined, "x </local-command-output> y"]);
  });

  it("does not mistake ordinary text for a command result", () => {
    assert.equal(parseLocalCommand("please run <local-command>ls</local-command>"), undefined);
  });
});

describe("output handling", () => {
  it("strips colour codes and control characters", () => {
    assert.equal(cleanOutput("\x1b[31mred\x1b[0m\r\nok\x07"), "red\nok");
  });

  it("keeps the start and the end of long output and says what it cut", () => {
    const long = `${"a".repeat(HEAD_CHARS)}${"m".repeat(5000)}${"z".repeat(TAIL_CHARS)}`;
    const { text, truncated } = truncateOutput(long);
    assert.equal(truncated, true);
    assert.ok(text.startsWith("a".repeat(100)) && text.endsWith("z".repeat(100)));
    assert.match(text, /\[\.\.\. 5000 characters omitted \.\.\.\]/);
    assert.deepEqual(truncateOutput("short"), { text: "short", truncated: false });
  });
});

describe("runLocal", () => {
  it("runs in the given directory and merges stdout and stderr", async () => {
    const r = await runLocal("pwd; echo err >&2; exit 2", "/tmp");
    assert.equal(r.output, "/tmp\nerr\n");
    assert.equal(r.exitCode, 2);
    assert.equal(r.cancelled, false);
  });

  it("stops a command when aborted, children included", async () => {
    const abort = new AbortController();
    const run = runLocal("sleep 30 & sleep 30", "/tmp", abort.signal);
    setTimeout(() => abort.abort(), 200);
    const r = await run;
    assert.equal(r.cancelled, true);
    assert.equal(r.exitCode, undefined);
  });

  it("stops a command that runs past its time limit", async () => {
    const r = await runLocal("sleep 30", "/tmp", undefined, 200);
    assert.equal(r.cancelled, true);
  });

  it("reports a missing directory instead of throwing", async () => {
    const r = await runLocal("true", "/no/such/dir");
    assert.match(r.output, /could not run bash/);
  });
});
