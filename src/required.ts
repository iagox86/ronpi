// The ronpi-shipped pi resources that ronpi needs to function, in one place:
// the audit at daemon start (`auditRequired`) and the tools every child is
// started with (`RONPI_TOOLS`) both read this list.
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

export interface Required {
  /** Directory under the pi agent dir. */
  kind: "extensions" | "skills";
  /** Entry name under that directory (file or folder, as install.ts links it). */
  name: string;
  /** What breaks without it. */
  why: string;
  /** Tool the resource registers, if any. */
  tool?: string;
}

export const REQUIRED: readonly Required[] = [
  { kind: "extensions", name: "ronpi-session-bridge.ts", why: "messages from other sessions fall back to pi's lossy steering queue" },
  { kind: "extensions", name: "ronpi-presence.ts", why: "sessions are not announced to each other" },
  { kind: "extensions", name: "ronpi-agents.ts", why: "the ronpi_message tool (messaging other sessions) is missing", tool: "ronpi_message" },
  { kind: "extensions", name: "ronpi-usage.ts", why: "the ronpi_usage tool and usage reporting are missing", tool: "ronpi_usage" },
  { kind: "skills", name: "messaging", why: "agents are not told how to use ronpi_message" },
];

/** `--tools` modifiers that add ronpi's tools to whatever loadout a session has or restores. */
export const RONPI_TOOLS: readonly string[] = REQUIRED.flatMap((r) => (r.tool ? [`+${r.tool}`] : []));

export interface Problem {
  item: Required;
  /** missing = nothing there; stale = present but a dangling link. */
  state: "missing" | "dangling";
}

/** Which required resources are absent from the pi agent dir `dir`. */
export function auditRequired(dir: string, required: readonly Required[] = REQUIRED): Problem[] {
  const problems: Problem[] = [];
  for (const item of required) {
    const path = join(dir, item.kind, item.name);
    if (existsSync(path)) {
      continue;
    }
    let isLink = false;
    try {
      isLink = lstatSync(path).isSymbolicLink();
    } catch {
      // not there at all
    }
    problems.push({ item, state: isLink ? "dangling" : "missing" });
  }
  return problems;
}

/** One line for the log and the switcher notice; undefined when nothing is wrong. */
export function describeProblems(problems: readonly Problem[]): string | undefined {
  if (problems.length === 0) {
    return undefined;
  }
  const names = problems.map((p) => `${p.item.name} (${p.state})`).join(", ");
  return `ronpi resources not installed: ${names} - run node src/install.ts, then restart affected sessions`;
}
