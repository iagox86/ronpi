import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Clipboard, copyFailureMessage, imageTypeOf, isTextType, onPath, runWrite, type Runner } from "../src/clipboard.ts";

const WAYLAND = { WAYLAND_DISPLAY: "wayland-0" } as NodeJS.ProcessEnv;

function recorder(answers: Record<string, string | Buffer | Error>) {
  const calls: Array<{ cmd: string; args: string[]; input?: unknown }> = [];
  const run: Runner = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const answer = answers[`${cmd} ${args.join(" ")}`];
    if (answer instanceof Error || answer === undefined) {
      throw answer ?? new Error("no such answer");
    }
    return Buffer.from(answer);
  };
  return { run, calls };
}

describe("Clipboard", () => {
  it("uses wl-clipboard on Wayland, xclip on X11, and says when there is neither", () => {
    assert.equal(new Clipboard(WAYLAND, undefined, () => true).backend, "wayland");
    assert.equal(new Clipboard({ DISPLAY: ":0" } as NodeJS.ProcessEnv, undefined, () => true).backend, "x11");
    assert.equal(new Clipboard({} as NodeJS.ProcessEnv, undefined, () => true).available, false);
  });

  it("reads the primary selection and the clipboard through different flags", async () => {
    const { run, calls } = recorder({
      "wl-paste --no-newline --type text --primary": "highlighted",
      "wl-paste --no-newline --type text": "copied",
    });
    const cb = new Clipboard(WAYLAND, run, () => true);
    assert.equal(await cb.readText("primary"), "highlighted");
    assert.equal(await cb.readText("clipboard"), "copied");
    assert.equal(calls.length, 2);
  });

  it("returns nothing, not an error, when the selection is empty or the tool fails", async () => {
    const cb = new Clipboard(WAYLAND, recorder({}).run, () => true);
    assert.equal(await cb.readText("primary"), undefined);
    assert.deepEqual(await cb.types("clipboard"), []);
    assert.equal(await cb.readImage(), undefined);
  });

  it("reads a clipboard image as png when offered", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { run } = recorder({
      "wl-paste --list-types": "text/html\nimage/jpeg\nimage/png\n",
      "wl-paste --type image/png": png,
    });
    const image = await new Clipboard(WAYLAND, run, () => true).readImage();
    assert.equal(image?.mimeType, "image/png");
    assert.deepEqual(image?.data, png);
  });

  it("writes text to every requested selection", async () => {
    const { run, calls } = recorder({ "wl-copy ": "", "wl-copy --primary": "" });
    assert.equal(await new Clipboard(WAYLAND, run, () => true).writeText("hello", ["clipboard", "primary"]), true);
    assert.deepEqual(calls.map((c) => [c.args.join(" "), c.input]), [["", "hello"], ["--primary", "hello"]]);
  });

  it("reports a failed write", async () => {
    assert.equal(await new Clipboard(WAYLAND, recorder({}).run, () => true).writeText("x", ["primary"]), false);
  });
});

describe("Clipboard tool check", () => {
  const have = (...cmds: string[]) => (cmd: string) => cmds.includes(cmd);

  it("works when the display's tools are installed", () => {
    const cb = new Clipboard(WAYLAND, undefined, have("wl-paste", "wl-copy"));
    assert.equal(cb.problem, undefined);
    assert.equal(cb.available, true);
  });

  it("names the missing Wayland tool and the package that provides it", () => {
    const cb = new Clipboard(WAYLAND, undefined, have("wl-copy"));
    assert.equal(cb.available, false);
    assert.match(cb.problem ?? "", /wl-paste not found: install wl-clipboard/);
  });

  it("asks for xclip on X11", () => {
    const cb = new Clipboard({ DISPLAY: ":0" } as NodeJS.ProcessEnv, undefined, have());
    assert.match(cb.problem ?? "", /xclip not found: install xclip/);
  });

  it("explains a session with no display at all", () => {
    assert.match(new Clipboard({} as NodeJS.ProcessEnv, undefined, have()).problem ?? "", /no Wayland or X11 display/);
    assert.match(new Clipboard({ SSH_CONNECTION: "1 2 3 4" } as NodeJS.ProcessEnv, undefined, have()).problem ?? "", /over ssh.*ctrl-shift-v/);
  });

  it("finds real programs on the PATH and not made-up ones", () => {
    assert.equal(onPath("sh", { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv), true);
    assert.equal(onPath("definitely-not-installed-xyz", { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv), false);
  });
});

describe("clipboard types", () => {
  it("tells text types from images and markup", () => {
    assert.ok(isTextType("text/plain;charset=utf-8"));
    assert.ok(isTextType("UTF8_STRING"));
    assert.ok(!isTextType("text/html"));
    assert.ok(!isTextType("image/png"));
  });

  it("prefers png, else any image, else none", () => {
    assert.equal(imageTypeOf(["image/jpeg", "image/png"]), "image/png");
    assert.equal(imageTypeOf(["text/html", "image/webp"]), "image/webp");
    assert.equal(imageTypeOf(["text/plain"]), undefined);
  });
});

describe("copyFailureMessage", () => {
  it("names the tool and points at the display variable to check first", () => {
    assert.equal(copyFailureMessage("wayland"), "Copy failed (wl-clipboard error; check WAYLAND_DISPLAY)");
    assert.equal(copyFailureMessage("x11"), "Copy failed (xclip error; check DISPLAY)");
    assert.equal(copyFailureMessage(undefined), "Copy failed (wl-clipboard error; check WAYLAND_DISPLAY)");
  });
});

describe("runWrite", () => {
  it("returns when the tool exits, not when a background process it left behind closes the pipes", async () => {
    // wl-copy and xclip fork a process that keeps serving the selection
    const started = Date.now();
    await runWrite("sh", ["-c", "cat >/dev/null; sleep 3 & exit 0"], "text");
    assert.ok(Date.now() - started < 1500, `waited ${Date.now() - started}ms for the background process`);
  });

  it("rejects when the tool exits non-zero", async () => {
    await assert.rejects(runWrite("sh", ["-c", "cat >/dev/null; exit 3"], "text"), /exited 3/);
  });

  it("rejects when the tool is not installed", async () => {
    await assert.rejects(runWrite("ronpi-no-such-tool", [], "text"));
  });
});
