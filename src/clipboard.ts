// System clipboard and the X/Wayland "primary selection" (what you last
// highlighted, pasted with the middle button), through the command-line tools:
// wl-clipboard on Wayland, xclip on X11. Neither is a hard dependency; without
// one, `available` is false and callers say so.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type Selection = "clipboard" | "primary";

/** Runs a program and resolves with its stdout; rejects when it fails or takes too long. */
export type Runner = (cmd: string, args: string[], input?: Buffer | string) => Promise<Buffer>;

const TOOL_TIMEOUT_MS = 4_000;
const MAX_BYTES = 32 * 1024 * 1024;

const defaultRun: Runner = (cmd, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: "buffer", timeout: TOOL_TIMEOUT_MS, maxBuffer: MAX_BYTES }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
    child.stdin?.on("error", () => {
      // the tool may exit before reading its input; the callback reports why
    });
    child.stdin?.end(input);
  });

/** A clipboard type that carries text rather than an image or markup. */
export const isTextType = (type: string): boolean => /^(text\/plain\b|UTF8_STRING$|STRING$|TEXT$)/.test(type);

/** The clipboard type to read an image as: png when offered, else the first image type. */
export function imageTypeOf(types: readonly string[]): string | undefined {
  return types.find((t) => t === "image/png") ?? types.find((t) => t.startsWith("image/"));
}

/** Whether `cmd` is an executable on the PATH. */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PATH ?? "").split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

const TOOLS = {
  wayland: { programs: ["wl-paste", "wl-copy"], package: "wl-clipboard" },
  x11: { programs: ["xclip"], package: "xclip" },
} as const;

export class Clipboard {
  readonly backend: "wayland" | "x11" | undefined;
  /** Why pasting is off, in a sentence for the user; undefined when it works. */
  readonly problem: string | undefined;
  private readonly run: Runner;

  /** `exists` says whether a program is installed (the PATH by default; tests pass their own). */
  constructor(env: NodeJS.ProcessEnv = process.env, run: Runner = defaultRun, exists: (cmd: string) => boolean = (cmd) => onPath(cmd, env)) {
    this.run = run;
    const backend = env.WAYLAND_DISPLAY ? "wayland" : env.DISPLAY ? "x11" : undefined;
    if (!backend) {
      this.backend = undefined;
      this.problem = "no Wayland or X11 display, so paste and copy-to-clipboard are off";
      return;
    }
    const missing = TOOLS[backend].programs.filter((program) => !exists(program));
    if (missing.length > 0) {
      this.backend = undefined;
      this.problem = `${missing.join(" and ")} not found: install ${TOOLS[backend].package} for ctrl-v / middle-click paste`;
      return;
    }
    this.backend = backend;
    this.problem = undefined;
  }

  get available(): boolean {
    return this.backend !== undefined;
  }

  /** What formats the selection offers (empty when it is empty or the tool is missing). */
  async types(which: Selection): Promise<string[]> {
    try {
      const out = this.backend === "wayland"
        ? await this.run("wl-paste", ["--list-types", ...(which === "primary" ? ["--primary"] : [])])
        : await this.run("xclip", ["-selection", which, "-t", "TARGETS", "-o"]);
      return out.toString("utf8").split("\n").map((t) => t.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async readText(which: Selection): Promise<string | undefined> {
    try {
      const out = this.backend === "wayland"
        ? await this.run("wl-paste", ["--no-newline", "--type", "text", ...(which === "primary" ? ["--primary"] : [])])
        : await this.run("xclip", ["-selection", which, "-o"]);
      const text = out.toString("utf8");
      return text.length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  }

  /** The clipboard's image (png preferred), if it holds one. */
  async readImage(): Promise<{ mimeType: string; data: Buffer } | undefined> {
    const mimeType = imageTypeOf(await this.types("clipboard"));
    if (!mimeType) {
      return undefined;
    }
    try {
      const data = this.backend === "wayland"
        ? await this.run("wl-paste", ["--type", mimeType])
        : await this.run("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
      return data.length > 0 ? { mimeType, data } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Put text on each of the given selections; true when all of them took it. */
  async writeText(text: string, targets: readonly Selection[]): Promise<boolean> {
    try {
      for (const which of targets) {
        if (this.backend === "wayland") {
          await this.run("wl-copy", which === "primary" ? ["--primary"] : [], text);
        } else {
          await this.run("xclip", ["-selection", which, "-i"], text);
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
