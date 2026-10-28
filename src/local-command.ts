// `!command`: a shell command the user runs inside a session. ronpi runs it
// itself and hands the agent the result as an ordinary message wrapped in
// <local-command> tags (the way Claude Code does), so the agent sees it at once
// and cannot mistake it for something pasted in. The same tags are what the
// transcript recognises to draw it as a command block.
import { spawn } from "node:child_process";

export interface LocalResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  /** The output was cut to fit. */
  truncated: boolean;
}

/** Output kept for the agent and the screen: the start and the end, which is where errors usually are. */
export const HEAD_CHARS = 8_000;
export const TAIL_CHARS = 16_000;
export const TIMEOUT_MS = 10 * 60_000;

/** Strip colour codes and other control characters from command output. */
export function cleanOutput(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) {
    return { text, truncated: false };
  }
  const omitted = text.length - HEAD_CHARS - TAIL_CHARS;
  return { text: `${text.slice(0, HEAD_CHARS)}\n[... ${omitted} characters omitted ...]\n${text.slice(text.length - TAIL_CHARS)}`, truncated: true };
}

/** Run `command` with bash in `cwd`; `signal` aborts it (the whole process group). Never rejects. */
export function runLocal(command: string, cwd: string, signal?: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<LocalResult> {
  return new Promise((resolve) => {
    let raw = "";
    let cancelled = false;
    const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const stop = () => {
      cancelled = true;
      try {
        process.kill(-(child.pid as number), "SIGTERM");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          process.kill(-(child.pid as number), "SIGKILL");
        } catch {
          // already gone
        }
      }, 2_000).unref();
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    const take = (chunk: Buffer) => {
      // keep memory bounded for a command that never stops printing
      if (raw.length < 4 * (HEAD_CHARS + TAIL_CHARS)) {
        raw += chunk.toString("utf8");
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ output: `could not run bash: ${err.message}`, exitCode: undefined, cancelled: false, truncated: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const { text, truncated } = truncateOutput(cleanOutput(raw));
      resolve({ output: text, exitCode: cancelled ? undefined : (code ?? undefined), cancelled, truncated });
    });
  });
}

const CAVEAT =
  "<local-command-caveat>The user ran this shell command themselves with the `!` shortcut in this session's working directory. You did not run it and it is not pasted text; the output is real and current. Respond only if the user's message needs it, otherwise a short acknowledgement is enough.</local-command-caveat>";
const CLOSE = "</local-command-output>";
const ESCAPED_CLOSE = "<\\/local-command-output>";

/** The message the agent receives. */
export function formatLocalCommand(command: string, r: LocalResult): string {
  const status = r.cancelled ? ' status="cancelled"' : r.exitCode === undefined ? "" : ` exit="${r.exitCode}"`;
  const body = r.output.replaceAll(CLOSE, ESCAPED_CLOSE);
  return `${CAVEAT}\n<local-command>${command}</local-command>\n<local-command-output${status}>\n${body}\n${CLOSE}`;
}

export interface ParsedLocalCommand {
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
}

/** The command and result in a message made by `formatLocalCommand`; undefined for any other text. */
export function parseLocalCommand(text: string): ParsedLocalCommand | undefined {
  const m = /<local-command>([\s\S]*?)<\/local-command>\n<local-command-output((?: [a-z]+="[^"]*")*)>\n([\s\S]*)\n<\/local-command-output>\s*$/.exec(text);
  if (!m) {
    return undefined;
  }
  const attrs = m[2] ?? "";
  const exit = /exit="(\d+)"/.exec(attrs);
  return {
    command: m[1] as string,
    output: (m[3] as string).replaceAll(ESCAPED_CLOSE, CLOSE),
    exitCode: exit ? Number(exit[1]) : undefined,
    cancelled: /status="cancelled"/.test(attrs),
  };
}
