// Daemon process lifecycle as seen from a controller: detect, auto-start,
// wait for, and stop the daemon.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { PID_FILE, SOCK } from "./config.ts";

const DAEMON_FILE = path.join(import.meta.dirname, "daemon.ts");

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when something is listening on the socket. */
export function socketAlive(timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(SOCK);
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

/** Start the daemon detached, using this process's node (same v26 binary). */
function spawnDaemon(): void {
  const child = spawn(process.execPath, [DAEMON_FILE], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function waitForDaemon(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socketAlive()) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`daemon did not come up within ${Math.round(timeoutMs / 1000)}s (check ${SOCK} and the daemon log)`);
}

/**
 * Make sure a daemon is listening. Re-checks briefly first (another
 * controller may be mid-start), then starts one in the background.
 */
export async function ensureDaemon(): Promise<void> {
  if (await socketAlive()) {
    return;
  }
  await sleep(400);
  if (!(await socketAlive())) {
    spawnDaemon();
    await waitForDaemon(20_000);
  }
}

/** controller.ts kill-server: SIGTERM the daemon (orderly child shutdown). */
export async function killServer(): Promise<void> {
  let pid: number | undefined;
  try {
    pid = Number.parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {
    // no pidfile below
  }
  if (!pid || Number.isNaN(pid)) {
    process.stderr.write(`no ronpid pidfile at ${PID_FILE} - daemon not running\n`);
    process.exit(1);
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!cmdline.includes("daemon.ts")) {
      process.stderr.write(`pid ${pid} is not ronpid (stale pidfile); refusing\n`);
      process.exit(1);
    }
  } catch {
    process.stderr.write(`daemon process ${pid} is gone (stale pidfile); cleaning up\n`);
    fs.rmSync(PID_FILE, { force: true });
    process.exit(1);
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      process.stdout.write(`ronpid (${pid}) stopped\n`);
      return;
    }
    await sleep(250);
  }
  process.kill(pid, "SIGKILL");
  process.stdout.write(`ronpid (${pid}) did not exit in 10s; sent SIGKILL\n`);
}
