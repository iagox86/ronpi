// /feedback, shared by the session and switcher command sets.
import type { Invocation } from "./cli.ts";
import { LOG } from "./config.ts";
import { appendFeedback, formatFeedback, piVersion, readFeedback, torielRevision, sessionPosition } from "./feedback.ts";
import type { Host } from "./host.ts";
import { loadSettings, resolveChildConfig } from "./settings.ts";

/** `key` is the session file of the session on screen or highlighted, if any. */
export function runFeedback(h: Host, call: Invocation, key: string | undefined): void {
  if (call.opts.list === true) {
    h.infoPanel.show(formatFeedback(readFeedback()));
    return;
  }
  const text = call.args.join(" ").trim();
  if (!text) {
    h.notify("/feedback: say what went wrong (or -l to list what is recorded)");
    return;
  }
  const meta = key ? h.metaForPath(key) : undefined;
  const file = key?.startsWith("/") ? key : meta?.sessionFile;
  try {
    appendFeedback({
      at: new Date().toISOString(),
      source: "user",
      text,
      category: call.opts.category as string | undefined,
      session: file
        ? {
            file,
            name: meta?.sessionName,
            model: meta?.model,
            provider: meta?.provider,
            ...sessionPosition(file),
          }
        : undefined,
      cwd: meta?.cwd,
      env: { toriel: torielRevision(), pi: piVersion(resolveChildConfig(loadSettings().settings).piCli), daemonLog: LOG },
    });
    h.notify("feedback recorded");
  } catch (err) {
    h.notify(`feedback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
