// The /commands ronpi handles itself inside a session (SESSION_COMMANDS);
// anything else typed with a leading slash goes to pi.
import * as path from "node:path";
import { type Invocation, parseCommandLine } from "./cli.ts";
import { SESSION_COMMANDS, type SessionCommandName } from "./commands.ts";
import { fmtTokens } from "./format.ts";
import { addMcpServer, MCP_ACTIONS, mcpConfigFile, mcpEntry } from "./mcp.ts";
import { forkName, placeFork } from "./fork-placement.ts";
import { loadGroups, saveGroups, withParked } from "./groups.ts";
import type { Host } from "./host.ts";
import { displayName } from "./session-list.ts";
import { runFeedback } from "./feedback-command.ts";
import { explainLastThinking } from "./why.ts";
import { newView } from "./transcript.ts";
import type { SessionMeta } from "./shared.ts";

const INIT_PROMPT = [
  "Survey this project and write an AGENTS.md in its root for future agents.",
  "If one already exists, read it first and update it rather than starting over; keep anything that is still accurate.",
  "Cover: what the project does, what the main files and directories are for, how to build, run and test it, and the conventions the code follows (naming, style, error handling, anything a newcomer would get wrong).",
  "Base it on what you actually find in the code and config, not guesses; keep it concise, and skip anything obvious from file names alone.",
].join(" ");

const COMPACT_TIMEOUT_MS = 10 * 60_000;

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
      park: () => this.park(),
      abort: () => this.abort(),
      name: rename,
      rename,
      reload: () => this.reload(),
      model: (c) => this.model(c.args.join(" "), c.opts.list === true),
      fork: (c) => this.fork(c.opts.name as string | undefined, c.opts.switch !== false, c.args.join(" ")),
      feedback: (c) => runFeedback(this.h, c, this.h.viewing ?? undefined),
      why: (c) => this.why(c.opts.model as string | undefined),
      init: () => this.init(),
      clear: () => this.clear(),
      compact: (c) => this.compact(c.args.join(" ")),
      mcp: (c) => this.mcp(c.args[0], c.args[1], c.args.slice(2)),
    };
  }

  /** Mark the viewed session parked, stop its process unless it is busy, and return to the switcher. */
  private async park(): Promise<void> {
    const key = this.h.viewing;
    const meta = this.viewedMeta();
    const sessionId = meta?.sessionId ?? (key ? this.h.local.get(key)?.id : undefined);
    if (!sessionId) {
      this.h.notify("nothing to park yet - send a message first");
      return;
    }
    const groups = loadGroups();
    groups.parked = withParked(groups, sessionId, true);
    saveGroups(groups);
    let note = "parked";
    if (meta?.active) {
      if (meta.streaming || meta.pendingDialog) {
        note = "parked (still running: it is working or waiting on you)";
      } else {
        try {
          await this.h.request({ type: "deactivate", session: meta.id });
          note = "parked and stopped";
        } catch (err) {
          note = `parked, but stopping it failed: ${err instanceof Error ? err.message : err}`;
        }
      }
    }
    this.h.switching.open();
    this.h.switcher.hint = `${note} (using it again unparks it)`;
    this.h.tui.requestRender();
  }

  private viewedMeta(): SessionMeta | undefined {
    return this.h.viewing ? this.h.metaForPath(this.h.viewing) : undefined;
  }

  /**
   * The viewed session with a child we may drive. A session that is only a file
   * (after a controller or daemon restart, or stopped) is started first, so
   * commands work without sending a throwaway message; says why when it cannot.
   */
  private async liveMeta(): Promise<SessionMeta | undefined> {
    let meta = this.viewedMeta();
    if (meta?.attachedElsewhere) {
      this.h.notify("view-only: this session is attached in another controller");
      return undefined;
    }
    if (!meta?.active) {
      meta = await this.startViewed();
    }
    return meta;
  }

  /** Resume the viewed session's file in a fresh child, without prompting it. */
  private async startViewed(): Promise<SessionMeta | undefined> {
    const key = this.h.viewing;
    const known = this.viewedMeta() ?? (key ? this.h.local.get(key) : undefined);
    if (!key?.startsWith("/") || !known) {
      this.h.notify("nothing to start yet - send a message first");
      return undefined;
    }
    try {
      this.h.notify("starting session...");
      const r = (await this.h.request({
        type: "spawn",
        sessionFile: key,
        cwd: known.cwd || path.dirname(key),
        ready: true,
      })) as { sessionId?: number };
      const meta = typeof r?.sessionId === "number" ? this.h.sessions.get(r.sessionId) : undefined;
      if (!meta?.active) {
        throw new Error("the session did not start");
      }
      return meta;
    } catch (err) {
      this.fail("start", err);
      return undefined;
    }
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
    if (!this.viewedMeta()?.active) {
      // starting it loads everything fresh already
      if (await this.startViewed()) {
        this.h.notify("started - extensions, skills and settings loaded");
      }
      return;
    }
    const meta = await this.liveMeta();
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

  private async model(query: string, list: boolean): Promise<void> {
    const meta = await this.liveMeta();
    if (!meta) {
      return;
    }
    try {
      if (list || !query) {
        const r = (await this.h.request({ type: "model", session: meta.id })) as { current: string; models: string[] };
        if (list) {
          const rows = r.models.map((m) => `${m === r.current ? "*" : " "} ${m}`);
          this.h.infoPanel.show(`Models (* = current)\n\n${rows.join("\n")}\n\n/model <words> switches to the one that matches`);
        } else {
          this.h.choicePanel.open("Switch model", r.models, r.current, (choice) => void this.model(choice, false));
        }
        this.h.tui.requestRender();
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
    const meta = await this.liveMeta();
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

  /** Explain the last thinking block with the summary model; nothing is sent to the session. */
  private async why(model: string | undefined): Promise<void> {
    const key = this.h.viewing;
    if (!key?.startsWith("/")) {
      this.h.notify("nothing to explain yet - send a message first");
      return;
    }
    try {
      this.h.notify("reading the last thinking block...");
      this.h.infoPanel.show(await explainLastThinking(key, model));
      this.h.notify("");
      this.h.tui.requestRender();
    } catch (err) {
      this.fail("why", err);
    }
  }

  /** /mcp: our own list (pi shows its status as a one-line notice); the other actions are pi's, so they go to it. */
  private async mcp(action = "list", server?: string, target: string[] = []): Promise<void> {
    if (!(MCP_ACTIONS as readonly string[]).includes(action)) {
      this.h.notify(`/mcp: unknown action "${action}" - use ${MCP_ACTIONS.join(", ")}`);
      return;
    }
    if (action === "add") {
      await this.mcpAdd(server, target);
      return;
    }
    if (action !== "list") {
      this.h.editor.setText("");
      await this.h.session.prompt(`/mcp ${action}${server ? ` ${server}` : ""}`);
      return;
    }
    const meta = await this.liveMeta();
    if (!meta) {
      return;
    }
    try {
      this.h.notify("asking the MCP servers...");
      const r = (await this.h.request({ type: "mcp_status", session: meta.id }, 60_000)) as { text: string };
      this.h.infoPanel.show(`MCP servers\n\n${r.text}\n\n/mcp reconnect <server> - tab completes the names`);
      this.h.notify("");
      this.h.tui.requestRender();
    } catch (err) {
      this.fail("mcp", err);
    }
  }

  /** /init: an ordinary prompt asking the agent to write the project's AGENTS.md. */
  private async init(): Promise<void> {
    this.h.editor.setText("");
    await this.h.session.prompt(INIT_PROMPT);
  }

  /** /mcp add: write the server into pi's mcp.json, then reload so the session picks it up. */
  private async mcpAdd(name: string | undefined, target: string[]): Promise<void> {
    if (!name) {
      this.h.notify("/mcp add <name> <url | command args...>");
      return;
    }
    try {
      addMcpServer(mcpConfigFile(), name, mcpEntry(target));
    } catch (err) {
      this.h.notify(`/mcp add: ${err instanceof Error ? err.message : err}`);
      return;
    }
    this.h.editor.setText("");
    this.h.notify(`added "${name}" to ${mcpConfigFile()}`);
    await this.reload();
  }

  private async compact(instructions: string): Promise<void> {
    const meta = await this.liveMeta();
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
