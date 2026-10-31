// /btw: a question put to a throwaway copy of the session. pi runs once in
// print mode over a copy of the session file (so it sees the whole
// conversation), with no tools, and the copy is deleted afterwards - the
// session itself never sees the question or the answer.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const BTW_TIMEOUT_MS = 180_000;

/** The question with the rules of the side channel, so the model answers in one go instead of asking back. */
export function btwPrompt(question: string): string {
  return [
    "[side question - answer from the conversation so far]",
    "This is a quick aside from the user and not part of the task. You have no tools here and cannot run, read or",
    "change anything. The user cannot reply to this answer, so do not ask follow-up questions or offer to do more: say",
    "what you can from what you already know, and say plainly when you do not know. Keep it short.",
    "",
    `Question: ${question}`,
  ].join("\n");
}

/** pi arguments for the side run: print mode on the copy, nothing else loaded. */
export function btwArgs(piCli: string, sessionCopy: string, prompt: string, model?: string): string[] {
  const args = [piCli, "--print", "--session", sessionCopy, "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"];
  if (model) {
    args.push("--model", model);
  }
  args.push(prompt);
  return args;
}

export interface BtwOptions {
  piCli: string;
  /** The session's jsonl file; only read. */
  file: string;
  question: string;
  /** provider/id; default is whatever pi picks for the session. */
  model?: string;
  cwd?: string;
  timeoutMs?: number;
}

export async function askBtw(opts: BtwOptions): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-btw-"));
  const copy = path.join(dir, path.basename(opts.file));
  try {
    fs.copyFileSync(opts.file, copy);
    return await run(btwArgs(opts.piCli, copy, btwPrompt(opts.question), opts.model), opts);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(args: string[], opts: BtwOptions): Promise<string> {
  const limit = opts.timeoutMs ?? BTW_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.tmpdir(),
      env: { ...process.env, TORIEL_CHILD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no answer after ${Math.round(limit / 1000)}s`));
    }, limit);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const answer = out.trim();
      if (code === 0 && answer) {
        resolve(answer);
      } else {
        const why = err.trim().split("\n").slice(-3).join(" ");
        reject(new Error(code === 0 ? `empty answer${why ? `: ${why}` : ""}` : `pi exited with ${code}${why ? `: ${why}` : ""}`));
      }
    });
  });
}

/** Where /btw answers are saved: one markdown file per answer. */
export function btwDir(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME ?? path.join(env.HOME ?? "", ".local", "share");
  return path.join(data, "toriel", "btw");
}

export function saveBtw(question: string, answer: string, dir = btwDir(), now = new Date()): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `btw-${stamp}.md`);
  fs.writeFileSync(file, `# ${question}\n\n${answer}\n`);
  return file;
}
