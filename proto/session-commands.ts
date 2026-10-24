// The /commands ronpi handles itself inside a session (SESSION_COMMANDS);
// anything else typed with a leading slash goes to pi.
import { type Invocation, parseCommandLine } from "./cli.ts";
import { SESSION_COMMANDS, type SessionCommandName } from "./commands.ts";
import { fmtTokens } from "./format.ts";
import { forkName, placeFork } from "./fork-placement.ts";
import { loadGroups, saveGroups } from "./groups.ts";
import type { Host } from "./host.ts";
import { displayName } from "./session-list.ts";
import { newView } from "./transcript.ts";
import type { SessionMeta } from "./shared.ts";

const COMPACT_TIMEOUT_MS = 10 * 60_000;
const MODELS_SHOWN = 6;

export class SessionCommands {
  private readonly h: Host;

  constructor(host: Host) {
    this.h = host;
  }

  /** Run a "/name args" line; false when it is not one of ours (send it to pi). */
  run(text: string): boolean {
    const parsed = parseCommandLine(SESSION_COMMANDS, text);
    switch (parsed.kind) {
      case "unknown":
        return false;
      case "help":
        this.h.infoPanel.show(parsed.text);
        this.h.tui.requestRender();
        break;
      case "error":
        // the line stays in the editor so it can be corrected
        this.h.notify(`/${parsed.spec.name}: ${parsed.message} (/${parsed.spec.name} --help)`);
        return true;
      case "run":
        void this.handlers()[parsed.spec.name as SessionCommandName](parsed.call);
        if (parsed.spec.name === "exit") {
          return true;
        }
        break;
      default:
        parsed satisfies never;
    }
    this.h.editor.setText("");
    return true;
  }

  /** One handler per SESSION_COMMANDS entry (the Record type makes a missing one a compile error). */
  private handlers(): Record<SessionCommandName, (call: Invocation) => void | Promise<void>> {
    const rename = (c: Invocation) => this.rename(c.args.join(" "));
    return {
      exit: () => this.h.dispose(),
      quit: () => this.h.switching.open(),
      abort: () => this.abort(),
      name: rename,
      rename,
      reload: () => this.reload(),
      model: (c) => this.model(c.args.join(" ")),
      fork: (c) => this.fork(c.opts.name as string | undefined, c.opts.switch !== false, c.args.join(" ")),
      clear: () => this.clear(),
      compact: (c) => this.compact(c.args.join(" ")),
    };
  }

  private viewedMeta(): SessionMeta | undefined {
    return this.h.viewing ? this.h.metaForPath(this.h.viewing) : undefined;
  }

  /** The viewed session when it has a child we may drive; otherwise says why not. */
  private liveMeta(): SessionMeta | undefined {
    const meta = this.viewedMeta();
    if (!meta?.active) {
      this.h.notify("this session is not running yet - send a message first");
      return undefined;
    }
    if (meta.attachedElsewhere) {
      this.h.notify("view-only: this session is attached in another controller");
      return undefined;
    }
    return meta;
  }

  private fail(what: string, err: unknown): void {
    this.h.notify(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  private abort(): void {
    const meta = this.viewedMeta();
    if (meta?.id !== undefined && meta.attachedToYou) {
      this.h.send({ type: "abort", session: meta.id });
      this.h.notify("abort sent");
    } else {
      this.h.notify("nothing to abort here");
    }
  }

  private async rename(name: string): Promise<void> {
    const meta = this.viewedMeta();
    if (!name) {
      this.h.notify(meta?.sessionName ? `name: ${meta.sessionName}` : "unnamed - /name <name> to set one");
      return;
    }
    const key = this.h.viewing;
    if (!meta && !key?.startsWith("/")) {
      this.h.notify("nothing to name yet - send a message first");
      return;
    }
    try {
      await this.h.request(meta ? { type: "rename", session: meta.id, name } : { type: "rename", path: key!, name });
      this.h.notify(`renamed to ${name}`);
    } catch (err) {
      this.fail("rename", err);
    }
  }

  private async reload(): Promise<void> {
    const meta = this.liveMeta();
    if (!meta) {
      return;
    }
    try {
      this.h.notify("reloading...");
      await this.h.request({ type: "reload", session: meta.id });
      this.h.notify("reloaded - extensions, skills and settings re-read");
    } catch (err) {
      this.fail("reload", err);
    }
  }

  private async model(query: string): Promise<void> {
    const meta = this.liveMeta();
    if (!meta) {
      return;
    }
    try {
      if (!query) {
        const r = (await this.h.request({ type: "model", session: meta.id })) as { current: string; models: string[] };
        const shown = r.models.slice(0, MODELS_SHOWN).join(", ");
        const more = r.models.length > MODELS_SHOWN ? `, +${r.models.length - MODELS_SHOWN} more` : "";
        this.h.notify(`model: ${r.current} - /model <words> to switch: ${shown}${more}`);
        return;
      }
      const r = (await this.h.request({ type: "model", session: meta.id, query })) as { model: string };
      this.h.notify(`model: ${r.model}`);
    } catch (err) {
      this.fail("model", err);
    }
  }

  private async fork(name: string | undefined, enter: boolean, prompt: string): Promise<void> {
    const meta = this.viewedMeta();
    const key = this.h.viewing;
    if (!key?.startsWith("/")) {
      this.h.notify("nothing to fork yet - send a message first");
      return;
    }
    if (meta?.streaming) {
      this.h.notify("session is working; abort it first");
      return;
    }
    try {
      const cwd = meta?.cwd ?? this.h.local.get(key)?.cwd ?? process.cwd();
      const parentName = displayName(meta, this.h.local.get(key));
      const r = (await this.h.request({
        type: "adopt",
        path: key,
        cwd,
        fork: true,
        name: name ?? forkName(parentName),
        parentName,
      })) as { sessionId?: number; sessionUuid?: string };
      if (typeof r?.sessionId !== "number") {
        throw new Error("no session id");
      }
      this.placeInSwitcher(meta?.sessionId ?? this.h.local.get(key)?.id, r.sessionUuid);
      const forked = this.h.sessions.get(r.sessionId);
      if (!enter) {
        // the copy runs in the background; this view stays put
        if (prompt) {
          await this.h.request({ type: "prompt", session: r.sessionId, message: prompt });
        }
        this.h.notify(`forked${prompt ? " and prompted" : ""} - still in the original; the copy is in the switcher`);
        return;
      }
      if (forked) {
        this.h.viewing = this.h.keyFor(forked);
        this.h.rebuildChat();
        if (prompt) {
          void this.h.session.prompt(prompt);
        }
      } else {
        this.h.pendingEnterId = r.sessionId;
        this.h.pendingPrompt = prompt || null;
      }
      this.h.notify("forked - you are in the copy; the original is unchanged");
    } catch (err) {
      this.fail("fork", err);
    }
  }

  /** The fork sits right below its parent, in the parent's group. */
  private placeInSwitcher(parentId: string | undefined, forkId: string | undefined): void {
    if (!parentId || !forkId) {
      return;
    }
    const groups = loadGroups();
    placeFork(groups, parentId, forkId);
    saveGroups(groups);
  }

  private async clear(): Promise<void> {
    const meta = this.liveMeta();
    const key = this.h.viewing;
    if (!meta || !key) {
      return;
    }
    if (meta.streaming) {
      this.h.notify("session is working; abort it first");
      return;
    }
    try {
      await this.h.request({ type: "clear", session: meta.id });
      this.h.views.set(key, newView());
      this.h.summaries.delete(key);
      this.h.rebuildChat();
      this.h.syncHistory(true);
      void this.h.loadLocal();
      this.h.notify("cleared - same session, empty conversation (old contents moved to trash)");
    } catch (err) {
      this.fail("clear", err);
    }
  }

  private async compact(instructions: string): Promise<void> {
    const meta = this.liveMeta();
    if (!meta) {
      return;
    }
    if (meta.streaming) {
      this.h.notify("session is working; abort it first");
      return;
    }
    try {
      this.h.notify("compacting...");
      const r = (await this.h.request(
        { type: "compact", session: meta.id, instructions },
        COMPACT_TIMEOUT_MS,
      )) as { tokensBefore?: number; tokensAfter?: number };
      const sizes =
        r?.tokensBefore !== undefined
          ? `: ${fmtTokens(r.tokensBefore)}${r.tokensAfter !== undefined ? ` -> ~${fmtTokens(r.tokensAfter)}` : ""} tokens`
          : "";
      this.h.notify(`compacted${sizes}`);
    } catch (err) {
      this.fail("compact", err);
    }
  }
}
