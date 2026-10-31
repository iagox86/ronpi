// Test harness: runs a real daemon in an isolated temp dir against the fake pi.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { LineSplitter } from "../src/shared.ts";

const DAEMON = path.join(import.meta.dirname, "..", "src", "daemon.ts");
const FAKE_PI = path.join(import.meta.dirname, "fixtures", "fake-pi.mjs");

export interface Harness {
  dir: string;
  sock: string;
  sessionsDir: string;
  stop(): Promise<void>;
  connect(): Promise<Client>;
}

export async function startDaemon(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-test-"));
  const sock = path.join(dir, "toriel.sock");
  const sessionsDir = path.join(dir, "sessions");
  const env = {
    ...process.env,
    // the daemon's RpcClient spawns plain `node` from PATH
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    TORIEL_SOCK: sock,
    TORIEL_LOG: path.join(dir, "daemon.log"),
    TORIEL_TRASH: path.join(dir, "trash"),
    TORIEL_PI_CLI: FAKE_PI,
    XDG_DATA_HOME: path.join(dir, "data"),
    FAKE_PI_DIR: sessionsDir,
    ...extraEnv,
  };
  const proc: ChildProcess = spawn(process.execPath, [DAEMON], { env, stdio: "ignore" });
  const clients: Client[] = [];
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(sock)) {
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error("daemon did not start");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return {
    dir,
    sock,
    sessionsDir,
    async connect() {
      const c = await Client.connect(sock);
      clients.push(c);
      return c;
    },
    async stop() {
      for (const c of clients) {
        c.close();
      }
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
          resolve();
          return;
        }
        proc.once("exit", () => resolve());
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Wire messages are checked field-by-field in tests, not modelled.
// biome-ignore lint/suspicious/noExplicitAny: loosely-typed protocol messages
export type Msg = Record<string, any>;

export class Client {
  messages: Msg[] = [];
  private socket: net.Socket;
  private seq = 0;
  private waiters: Array<() => void> = [];

  private constructor(socket: net.Socket) {
    this.socket = socket;
    const splitter = new LineSplitter();
    socket.on("data", (chunk: Buffer) => {
      for (const line of splitter.push(chunk.toString("utf8"))) {
        this.messages.push(JSON.parse(line));
      }
      for (const w of this.waiters.splice(0)) {
        w();
      }
    });
  }

  static connect(sock: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(sock);
      socket.once("connect", () => resolve(new Client(socket)));
      socket.once("error", reject);
    });
  }

  send(msg: Msg): void {
    this.socket.write(`${JSON.stringify(msg)}\n`);
  }

  /** Send a command and resolve with its response (rejects on ok:false). */
  async request(cmd: Msg): Promise<Msg> {
    const id = `t${++this.seq}`;
    this.send({ ...cmd, id });
    const res = await this.waitFor((m) => m.type === "response" && m.id === id);
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res.data;
  }

  /** Resolve with the first message (already received or future) matching. */
  async waitFor(pred: (m: Msg) => boolean, timeoutMs = 8000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    let from = 0;
    for (;;) {
      for (; from < this.messages.length; from++) {
        if (pred(this.messages[from])) {
          return this.messages[from];
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for message; saw ${JSON.stringify(this.messages.slice(-5))}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Latest session list this client has received. */
  sessions(): Msg[] {
    const last = [...this.messages].reverse().find((m) => m.type === "sessions");
    return last?.sessions ?? [];
  }

  close(): void {
    this.socket.destroy();
  }
}
