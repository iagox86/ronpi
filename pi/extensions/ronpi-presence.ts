// ronpi presence: registers this pi process with the ronpi daemon (if one is
// running) so the switcher can show that the session is live in an external
// pi process and avoid double-driving it. Best-effort: when no daemon is
// running, everything here is a silent no-op.
import { connect } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const sockPath = process.env.RONPI_SOCK ?? `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/ronpi.sock`;

export default function (pi: ExtensionAPI) {
  // daemon-owned children register through the daemon itself - never as
  // "external" processes
  if (process.env.RONPI_CHILD) {
    return;
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let sessionFile = "";

  const send = (file: string, live: boolean) => {
    if (!file) {
      return;
    }
    const s = connect(sockPath);
    s.on("connect", () => {
      s.write(
        JSON.stringify({
          type: "external_register",
          pid: process.pid,
          sessionFile: file,
          cwd: process.cwd(),
          live,
        }) + "\n",
      );
      s.end();
    });
    s.on("error", () => {
      // daemon not running - presence is best-effort
    });
  };

  pi.on("session_start", (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile() ?? "";
    // teardown can re-fire session_start with an empty session - don't
    // clobber the registration with it
    if (!file) {
      return;
    }
    sessionFile = file;
    send(file, true);
    if (!timer) {
      timer = setInterval(() => send(sessionFile, true), 30_000);
      timer.unref?.();
    }
  });

  pi.on("session_shutdown", () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    send(sessionFile, false);
    sessionFile = "";
  });
}
