// Switcher-side actions of the controller: opening/closing the list, row
// actions (enter/new/kill/rename/group/move), the command line and its keys.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KEY_LOG, TRASH_DIR } from "./config.ts";
import { matching } from "./completion.ts";
import { fmtAge, firstMessageLabel } from "./format.ts";
import { listTrashedSessions, type TrashedSession } from "./trash.ts";
import { log } from "./log.ts";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { type Invocation, listing, parseCommandLine } from "./cli.ts";
import { SWITCHER_COMMANDS, type SwitcherCommandName } from "./commands.ts";
import type { Host } from "./host.ts";
import { loadGroups, pruneStale, resolveGroup, saveGroups, type GroupsFile, withComment, withParked } from "./groups.ts";
import { compileFilter, type Filter } from "./session-filter.ts";
import { loadSettings } from "./settings.ts";
import { DEFAULT_INTERVAL_MINUTES, needsResummary, type SummaryEntry, summarizeFile, summaryModel, transcriptOf, autoSummaryFailure } from "./summarize.ts";
import {
  buildSessionList,
  appendUnranked,
  deleteEmptyGroup,
  moveGroup,
  moveSession,
  sortSessions,
  type MutationResult,
} from "./session-list.ts";
import { detachFromParent, loadLineage, parentMap } from "./lineage.ts";
import { arrangeTree } from "./session-tree.ts";
import { loadAgentsChecked } from "./agents.ts";
import { agentListing } from "./agents-completion.ts";
import { runFeedback } from "./feedback-command.ts";
import type { SwitcherSession } from "./switcher.ts";
import { itemsFromFile, newView } from "./transcript.ts";

const LOCK_BITS = 64 | 128; // kitty caps_lock / num_lock, reported in the modifier field

/**
 * pi-tui misses the kitty-protocol spelling of F2 (CSI 1;mods Q). Lock keys
 * add to the modifier (num lock on = 129), so ignore them; no other modifier
 * counts as plain F2.
 */
export function isF2(data: string): boolean {
  if (matchesKey(data, "f2") || data === "\x1b[Q") {
    return true;
  }
  const m = /^\x1b\[1;(\d+)(?::([12]))?Q$/.exec(data);
  return m !== null && ((Number(m[1]) - 1) & ~LOCK_BITS) === 0;
}

/** Most sessions one automatic pass will summarize (a local model is slow). */
const MAX_AUTO_PER_RUN = 10;

export class SwitcherActions {
  groups: GroupsFile = { groups: [], assignments: {} };
  isOpen = false;

  private lastRefused: string | null = null;
  private armedDelete: string | null = null;
  /** Session key order captured when the switcher opened; frozen while open. */
  private switchOrder: string[] | null = null;

  private readonly h: Host;

  constructor(host: Host) {
    this.h = host;
  }

  open(): void {
    // Release input on the session we were driving; re-enter re-attaches.
    if (this.h.viewing) {
      const meta = this.h.metaForPath(this.h.viewing);
      if (meta?.attachedToYou) {
        this.h.send({ type: "detach", session: meta.id });
      }
    }
    this.groups = loadGroups();
    this.filter = null;
    this.liveFilter = false;
    this.h.editor.onChange = undefined;
    this.switchOrder = null;
    this.armedDelete = null;
    this.lastRefused = null;
    this.h.session.resetArmed();
    // Land on the session we were just in, else the first session.
    this.h.switcher.selectedKey = this.h.viewing;
    this.refresh();
    this.h.switcher.height = this.h.tui.terminal.rows || 24;
    this.h.switcher.hint = "type / for commands, or a message to start a session - enter open - ctrl-n new - ctrl-k stop - ctrl-x delete - ctrl-r rename - ctrl-g group - ctrl-f filter";
    this.h.switcher.heightProvider = () => Math.max(6, (this.h.tui.terminal.rows || 24) - 4);
    this.isOpen = true;
    this.h.tui.setLayoutRoot(this.h.switcherLayout);
    this.h.editor.setText("");
    this.h.syncHistory();
    this.h.renderChrome();
    this.h.tui.requestRender(true);
  }

  close(): void {
    this.isOpen = false;
    this.filter = null;
    this.liveFilter = false;
    this.h.editor.onChange = undefined;
    this.h.tui.setLayoutRoot(this.h.chatLayout);
    this.h.rebuildChat();
    this.h.renderChrome();
    this.h.tui.requestRender(true);
  }

  refresh(): void {
    this.groups = loadGroups();
    let list = buildSessionList({
      daemon: this.h.sessions.values(),
      local: this.h.local,
      groups: this.groups,
      summaries: this.h.summaries,
      now: Date.now(),
    });
    // Freeze the display order while the switcher is open.
    if (this.switchOrder === null) {
      this.switchOrder = list.map((s) => s.key);
    }
    sortSessions(list, this.groups.order ?? [], this.switchOrder);
    list = arrangeTree(list, parentMap(loadLineage()));
    const order = appendUnranked(this.groups.order, list);
    if (order) {
      this.groups.order = order;
    }
    // an empty file list means the listing has not loaded, not that every session is gone
    const pruned = this.h.local.size > 0 && pruneStale(this.groups, new Set(list.flatMap((s) => (s.sessionId ? [s.sessionId] : []))));
    if (order || pruned) {
      saveGroups(this.groups);
    }
    if (KEY_LOG) {
      try {
        fs.appendFileSync(KEY_LOG, `REFRESH_SWITCHER paths=${list.length} local=${this.h.local.size} daemon=${this.h.sessions.size}: ${list.map((x) => x.key.split("/").pop()).join(",")}\n`);
      } catch {
        // debug only
      }
    }
    const shown = this.filter ? list.filter((x) => this.filter!.test(x)) : list;
    this.h.switcher.filterNote = this.filter
      ? `filter${this.filter.regex ? " (regex)" : ""}: ${this.filter.text}  -  ${shown.length} of ${list.length}  -  /filter clears`
      : "";
    this.h.switcher.groupMatches = this.filter ? (title) => this.filter!.testGroup(title) : undefined;
    this.h.switcher.sessions = shown;
    this.h.switcher.groups = this.groups.groups;
    this.h.switcher.collapsed = new Set(this.groups.collapsed);
    this.h.switcher.height = this.h.tui.terminal.rows || 24;
    this.h.switcher.refresh();
    this.h.tui.requestRender();
  }

  /** Open the session with this UUID from outside the switcher (/parent). False when it is not in the list. */
  async openSession(uuid: string): Promise<boolean> {
    this.refresh();
    const row = this.h.switcher.sessions.find((s) => s.sessionId === uuid);
    if (!row) {
      return false;
    }
    await this.enter(row);
    return true;
  }

  async enter(s: SwitcherSession): Promise<void> {
    if (s.daemonId !== undefined && (s.state === "streaming" || s.state === "idle" || s.state === "compacting")) {
      try {
        await this.h.request({ type: "attach", session: s.daemonId, force: this.lastRefused === s.key });
        this.lastRefused = null;
      } catch (err) {
        this.lastRefused = s.key;
        this.h.switcher.hint = `${err instanceof Error ? err.message : err} - enter again to take over`;
        this.h.tui.requestRender();
        return;
      }
    }
    this.h.viewing = s.key;
    if (!this.h.views.has(s.key)) {
      this.h.views.set(s.key, { ...newView(), items: itemsFromFile(s.key, this.h.tui, s.cwd ?? process.cwd()) });
    }
    this.close();
    this.h.rebuildChat();
  }

  /** Spawn a session; `firstMessage` is prompted once it is entered. */
  async newSession(firstMessage?: string, name?: string, cwd = process.cwd(), agent?: string): Promise<void> {
    try {
      const data = (await this.h.request({ type: "spawn", cwd, name: name ? this.h.uniqueSessionName(name) : name, agent })) as { sessionId?: number };
      if (typeof data?.sessionId === "number") {
        const meta = this.h.sessions.get(data.sessionId);
        if (meta) {
          this.h.viewing = this.h.keyFor(meta);
          this.close();
          if (firstMessage) {
            void this.h.session.prompt(firstMessage);
          }
        } else {
          this.h.pendingEnterId = data.sessionId;
          this.h.pendingPrompt = firstMessage ?? null;
          this.h.switcher.hint = "starting session...";
        }
      }
    } catch (err) {
      if (firstMessage) {
        this.h.editor.setText(firstMessage);
      }
      this.h.switcher.hint = `spawn failed: ${err instanceof Error ? err.message : err}`;
      this.h.tui.requestRender();
    }
  }

  /** Stop a live session's child; the file stays and it respawns on the next prompt. */
  async stop(s: SwitcherSession): Promise<void> {
    try {
      if (s.state !== "streaming" && s.state !== "idle" && s.state !== "compacting") {
        this.h.switcher.hint = `${s.name} is not running`;
      } else if (s.daemonId === undefined) {
        throw new Error("no daemon session");
      } else {
        await this.h.request({ type: "deactivate", session: s.daemonId });
        this.h.switcher.hint = `stopped ${s.name} (file kept; respawns on next prompt)`;
        this.refresh();
      }
    } catch (err) {
      this.h.switcher.hint = `stop failed: ${err instanceof Error ? err.message : err}`;
    }
    this.h.tui.requestRender();
  }

  /** Move to trash, with a press-twice confirm; a live child is stopped first (by the daemon). */
  async remove(s: SwitcherSession, confirmed = false): Promise<void> {
    try {
      if (!confirmed && this.armedDelete !== s.key) {
        this.armedDelete = s.key;
        const live = s.state === "streaming" || s.state === "idle" || s.state === "compacting";
        const kids = s.descendants ?? 0;
        const orphans = kids > 0 ? ` (its ${kids} ${kids === 1 ? "child stays" : "children stay"}, listed on their own)` : "";
        this.h.switcher.hint = `${s.name}: press ctrl-x again to ${live ? "stop it and " : ""}move to trash${orphans}`;
        this.h.tui.requestRender();
        return;
      }
      this.armedDelete = null;
      // keep the cursor where it is: select the next entry (or the
      // previous one at the end) before the row disappears
      this.h.switcher.selectNextAfter(s.key);
      await this.h.request({ type: "delete", path: s.key.startsWith("daemon:") ? undefined : s.key, session: s.daemonId });
      this.h.views.delete(s.key);
      await this.h.loadLocal();
      this.h.switcher.hint = `${s.name} moved to trash (/restore brings it back)`;
      this.refresh();
    } catch (err) {
      this.h.switcher.hint = `delete failed: ${err instanceof Error ? err.message : err}`;
    }
    this.h.tui.requestRender();
  }

  /** Deleted sessions to pick from; a single match (or a lone entry) is restored directly. */
  private async restoreFromTrash(query: string): Promise<void> {
    const saved = loadGroups().summaries ?? {};
    const label = (t: TrashedSession): string => {
      const title = t.name ?? (t.sessionId ? saved[t.sessionId]?.text : undefined) ?? firstMessageLabel(t.firstMessage ?? "", 50);
      const age = t.trashedAt ? `${fmtAge(Date.now() - Date.parse(t.trashedAt))} ago` : "earlier";
      const where = path.basename(t.cwd ?? path.dirname(t.originalPath));
      return `${title || "<unnamed>"}  [deleted ${age}, ${t.messages} msgs, ${where}] ${(t.sessionId ?? "").slice(0, 8)}`;
    };
    const entries = listTrashedSessions(TRASH_DIR).map((t) => ({ t, text: label(t) }));
    const shown = matching(entries.map((e) => e.text), query);
    const choices = entries.filter((e) => shown.includes(e.text));
    if (entries.length === 0) {
      this.h.switcher.hint = "the trash has no deleted sessions";
    } else if (choices.length === 0) {
      this.h.switcher.hint = `restore: nothing in the trash matches "${query}"`;
    } else if (choices.length === 1 && query) {
      await this.restoreOne(choices[0]!.t, choices[0]!.text);
    } else {
      this.h.choicePanel.open(
        "Restore which deleted session?",
        choices.map((e) => e.text),
        undefined,
        (picked) => {
          const chosen = choices.find((e) => e.text === picked);
          if (chosen) {
            void this.restoreOne(chosen.t, chosen.text);
          }
        },
      );
    }
    this.h.tui.requestRender();
  }

  private async restoreOne(t: TrashedSession, text: string): Promise<void> {
    try {
      await this.h.request({ type: "restore", trashedTo: t.trashedTo });
      await this.h.loadLocal();
      this.refresh();
      this.h.switcher.hint = `restored ${text.split("  [")[0]}`;
    } catch (err) {
      this.h.switcher.hint = `restore failed: ${err instanceof Error ? err.message : err}`;
    }
    this.h.tui.requestRender();
  }

  private summarizing = false;
  /** The reason the last unattended summary pass failed, so it is announced once. */
  private autoSummaryError: string | null = null;
  /** The temporary list filter (null = none). */
  private filter: Filter | null = null;
  /** ctrl-f: the box text is the filter and applies as it is typed. */
  private liveFilter = false;

  /** Set the filter from /filter-style text; returns an error message for a bad pattern. */
  private setFilter(text: string, regex: boolean): string | undefined {
    try {
      this.filter = compileFilter(text, regex);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    this.refresh();
    this.h.renderChrome(); // the status line names the highlighted row
    return undefined;
  }

  private clearFilter(): void {
    this.filter = null;
    this.liveFilter = false;
    this.h.editor.onChange = undefined;
    this.refresh();
    this.h.renderChrome();
  }

  /** ctrl-f: start filtering as you type (the box takes the same text as /filter). */
  private startLiveFilter(): void {
    this.liveFilter = true;
    this.h.editor.setText("");
    this.h.editor.onChange = (text) => this.applyLiveText(text);
    this.h.switcher.hint = "filter as you type - up/down move - enter keeps it - esc clears it (-r for a regex)";
    this.h.tui.requestRender();
  }

  private applyLiveText(text: string): void {
    const parsed = parseCommandLine(SWITCHER_COMMANDS, `/filter ${text}`);
    if (parsed.kind !== "run") {
      return; // a half-typed flag or quote: keep what is shown
    }
    const error = this.setFilter(parsed.call.args.join(" "), parsed.call.opts.regex === true);
    if (error) {
      this.h.switcher.hint = `filter: ${error}`;
      this.h.tui.requestRender();
    }
  }

  /** Keys while ctrl-f filtering; true when consumed. */
  private liveFilterKeys(data: string): boolean {
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.h.switcher.move(matchesKey(data, Key.up) ? -1 : 1);
      this.h.tui.requestRender();
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      // keep the filter, give the box back
      this.liveFilter = false;
      this.h.editor.onChange = undefined;
      this.h.editor.setText("");
      this.h.switcher.hint = "filter kept - esc or /filter clears it";
      this.h.tui.requestRender();
      return true;
    }
    if (matchesKey(data, Key.escape)) {
      this.h.editor.onChange = undefined;
      this.h.editor.setText("");
      this.clearFilter();
      this.h.switcher.hint = "";
      return true;
    }
    return false;
  }
  private autoSummaryLast = 0;

  /** Read-modify-write on a fresh copy, so a group edit made meanwhile is not lost. */
  private saveSummary(sessionId: string, entry: SummaryEntry): void {
    const groups = loadGroups();
    groups.summaries = { ...groups.summaries, [sessionId]: entry };
    saveGroups(groups);
  }

  /**
   * While toriel is open, every `summaryIntervalMinutes` (settings; default 60, 0 = off)
   * summarize sessions that have no summary yet or have changed since theirs.
   */
  startAutoSummary(): void {
    const timer = setInterval(() => void this.autoSummaryTick(), 60_000);
    timer.unref?.();
  }

  private async autoSummaryTick(): Promise<void> {
    const cfg = loadSettings().settings;
    const minutes = cfg.summaryIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    if (!minutes || this.summarizing || Date.now() - this.autoSummaryLast < minutes * 60_000) {
      return;
    }
    this.autoSummaryLast = Date.now();
    const saved = loadGroups().summaries ?? {};
    const live = new Map([...this.h.sessions.values()].map((m) => [m.sessionFile, m]));
    const todo = [...this.h.local.values()].filter((info) => {
      try {
        return needsResummary({
          entry: saved[info.id],
          messages: transcriptOf(info.path, 1).messages,
          modifiedMs: info.modified,
          now: Date.now(),
          streaming: live.get(info.path)?.streaming ?? false,
          minNew: cfg.summaryMinNewMessages,
        });
      } catch {
        return false;
      }
    });
    if (todo.length === 0) {
      return;
    }
    // most recently touched first, so live sessions are covered before a backlog of old ones
    todo.sort((a, b) => b.modified - a.modified);
    this.summarizing = true;
    try {
      const model = summaryModel();
      for (const info of todo.slice(0, MAX_AUTO_PER_RUN)) {
        this.saveSummary(info.id, await summarizeFile(info.path, model));
      }
      this.autoSummaryError = null;
    } catch (err) {
      // unattended: log every failure, but tell the user only when the reason changes
      log(`auto-summary failed: ${err instanceof Error ? err.message : err}`);
      const { notify, seen } = autoSummaryFailure(this.autoSummaryError, err);
      this.autoSummaryError = seen;
      if (notify) {
        this.h.notify(notify);
      }
    } finally {
      this.summarizing = false;
    }
    if (this.isOpen) {
      this.refresh();
      this.h.tui.requestRender();
    }
  }

  /** Summarize one session and save it; returns false (with a hint) on failure. */
  private async summarizeOne(t: SwitcherSession, model: string, chars?: number): Promise<boolean> {
    if (!t.key.startsWith("/") || !t.sessionId) {
      this.h.switcher.hint = `summarize: ${t.name} has no session file yet`;
      return false;
    }
    try {
      this.saveSummary(t.sessionId, await summarizeFile(t.key, model, chars));
      this.refresh();
      return true;
    } catch (err) {
      this.h.switcher.hint = `summarize ${t.name} failed: ${err instanceof Error ? err.message : err}`;
      return false;
    }
  }

  /** Sessions with no summary, or one for a different message count, one at a time (local models are slow). */
  private async summarizeAll(model: string, chars?: number): Promise<void> {
    const todo = this.h.switcher.sessions.filter((s) => {
      if (!s.key.startsWith("/") || !s.sessionId) {
        return false;
      }
      try {
        return this.groups.summaries?.[s.sessionId]?.messages !== transcriptOf(s.key).messages;
      } catch {
        return false;
      }
    });
    if (todo.length === 0) {
      this.h.switcher.hint = "summarize: every session already has a current summary";
      return;
    }
    for (const [i, t] of todo.entries()) {
      this.h.switcher.hint = `summarizing ${i + 1}/${todo.length}: ${t.name} (${model})...`;
      this.h.tui.requestRender();
      if (!(await this.summarizeOne(t, model, chars))) {
        return; // the hint says why; the same model would likely fail again
      }
    }
    this.h.switcher.hint = `summarized ${todo.length} session${todo.length === 1 ? "" : "s"} with ${model}`;
  }

  /** Persist a group/order mutation and refresh; shows the mutation's hint. */
  private applyGroupChange(result: MutationResult): void {
    if (result.hint) {
      this.h.switcher.hint = result.hint;
    }
    if (result.changed) {
      saveGroups(this.groups);
      this.refresh();
    }
    this.h.tui.requestRender();
  }

  /** shift+up/down on a session row: relocate within/between sections. */
  async moveSession(delta: number, s: SwitcherSession): Promise<void> {
    if (!s.sessionId) {
      this.h.switcher.hint = "session has no id yet - prompt it once, then move it";
      this.h.tui.requestRender();
      return;
    }
    const result = moveSession(this.groups, this.h.switcher.sessions, s, delta);
    // a session dragged into a folded group would vanish into it: unfold the group so it stays selected in view
    const into = this.groups.assignments[s.sessionId] ?? "(ungrouped)";
    if (result.changed && this.groups.collapsed?.includes(into)) {
      this.groups.collapsed = this.groups.collapsed.filter((g) => g !== into);
    }
    this.applyGroupChange(result);
  }

  /** shift+up/down on a group header: swap with the neighboring group. */
  async moveGroup(delta: number, title: string): Promise<void> {
    this.applyGroupChange(moveGroup(this.groups, title, delta));
  }

  /** ctrl-x on a group header: delete it (only when it has no sessions). */
  async deleteGroupIfEmpty(title: string): Promise<void> {
    const armKey = `group:${title}`;
    const deletable = title !== "(ungrouped)" && !this.h.switcher.sessions.some((s) => s.group === title);
    // a group that cannot be deleted just gets the explanation; an empty one needs a second ctrl-x
    if (deletable && this.armedDelete !== armKey) {
      this.armedDelete = armKey;
      this.h.switcher.hint = `${title}: press ctrl-x again to delete this group`;
      this.h.tui.requestRender();
      return;
    }
    this.armedDelete = null;
    this.applyGroupChange(deleteEmptyGroup(this.groups, this.h.switcher.sessions, title));
  }

  async runCommand(cmd: string, target: SwitcherSession | undefined): Promise<void> {
    const parsed = parseCommandLine(SWITCHER_COMMANDS, cmd);
    switch (parsed.kind) {
      case "unknown":
        this.h.switcher.hint = `unknown command: /${parsed.name} (/help)`;
        break;
      case "help":
        this.h.infoPanel.show(parsed.text);
        this.h.editor.setText("");
        break;
      case "error":
        this.h.switcher.hint = `/${parsed.spec.name}: ${parsed.message} (/${parsed.spec.name} --help)`;
        break;
      case "run":
        await this.commandHandlers()[parsed.spec.name as SwitcherCommandName](parsed.call, target);
        break;
      default:
        parsed satisfies never;
    }
    this.h.tui.requestRender();
  }

  /** One handler per SWITCHER_COMMANDS entry (the Record type makes a missing one a compile error). */
  private commandHandlers(): Record<SwitcherCommandName, (call: Invocation, target: SwitcherSession | undefined) => Promise<void>> {
    const needsTarget = (verb: string, run: (t: SwitcherSession, arg: string, call: Invocation) => Promise<void>) =>
      async (call: Invocation, target: SwitcherSession | undefined) => {
        if (!target) {
          this.h.switcher.hint = `${verb}: highlight a session first`;
          return;
        }
        await run(target, call.args.join(" "), call);
      };
    const leave = async () => {
      this.h.dispose();
    };
    return {
      new: async (call) => {
        const dir = call.opts.cwd as string | undefined;
        const cwd = dir === undefined ? undefined : path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
        if (cwd !== undefined && !(fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) {
          this.h.switcher.hint = `new: ${cwd} is not a directory`;
          return;
        }
        await this.newSession(undefined, call.opts.name as string | undefined, cwd, call.opts.agent as string | undefined);
      },
      agents: async () => {
        const { agents, problems } = loadAgentsChecked(process.cwd());
        this.h.infoPanel.show(agentListing(agents, problems));
      },
      feedback: async (call, target) => runFeedback(this.h, call, target?.key),
      stop: needsTarget("stop", (t) => this.stop(t)),
      delete: async (call, target) => {
        if (!target) {
          this.h.switcher.hint = "delete: highlight a session first";
          return;
        }
        await this.remove(target, call.opts.yes === true);
      },
      rename: needsTarget("rename", async (t, arg) => {
        if (!arg) {
          this.h.editor.setText("/rename ");
          this.h.switcher.hint = `rename: ${t.name} - type the new name and press enter`;
          return;
        }
        try {
          const unique = this.h.uniqueSessionName(arg, t.key);
          await this.h.request({
            type: "rename",
            session: t.daemonId,
            path: t.daemonId === undefined ? t.key : undefined,
            name: unique,
          });
          await this.h.loadLocal();
          this.refresh();
          this.h.switcher.hint = unique === arg ? `renamed to ${arg}` : `renamed to ${unique} (${arg} is taken)`;
        } catch (err) {
          this.h.switcher.hint = `rename failed: ${err instanceof Error ? err.message : err}`;
        }
      }),
      group: needsTarget("group", async (t, arg) => {
        if (!arg) {
          this.h.editor.setText("/group ");
          this.h.switcher.hint = `group: ${t.name} - type a group name and press enter`;
        } else if (!t.sessionId) {
          this.h.switcher.hint = "group: session has no id yet";
        } else {
          try {
            const group = resolveGroup(this.groups, arg);
            this.groups.assignments[t.sessionId] = group;
            saveGroups(this.groups);
            this.refresh();
            this.h.switcher.hint = `${t.name} -> ${group}`;
          } catch (err) {
            this.h.switcher.hint = `group failed: ${err instanceof Error ? err.message : err}`;
          }
        }
      }),
      park: needsTarget("park", async (t, _arg, call) => {
        if (!t.sessionId) {
          this.h.switcher.hint = "park: session has no id yet";
          return;
        }
        const undo = call.opts.undo === true;
        this.groups.parked = withParked(this.groups, t.sessionId, !undo);
        saveGroups(this.groups);
        this.refresh();
        this.h.switcher.hint = undo ? `${t.name} unparked` : `${t.name} parked (using it again unparks it)`;
      }),
      comment: needsTarget("comment", async (t, arg, call) => {
        if (!t.sessionId) {
          this.h.switcher.hint = "comment: session has no id yet";
          return;
        }
        if (!arg && call.opts.clear !== true) {
          this.h.editor.setText(`/comment ${t.comment ?? ""}`);
          this.h.switcher.hint = `comment: ${t.name} - edit the note and press enter`;
          return;
        }
        this.groups.comments = withComment(this.groups, t.sessionId, call.opts.clear === true ? "" : arg);
        saveGroups(this.groups);
        this.refresh();
        this.h.switcher.hint = call.opts.clear === true ? `${t.name}: comment removed` : `${t.name}: comment saved (searchable with /filter)`;
      }),
      detach: needsTarget("detach", async (t) => {
        const parent = t.sessionId ? detachFromParent(t.sessionId) : undefined;
        if (!parent) {
          this.h.switcher.hint = `${t.name} was not started by an agent - nothing to detach`;
        } else {
          this.h.forgetLineage();
          this.refresh();
          this.h.switcher.hint = `${t.name} detached from ${parent.name} - it is top-level now`;
        }
      }),
      ungroup: needsTarget("ungroup", async (t) => {
        if (!t.sessionId) {
          this.h.switcher.hint = "ungroup: session has no id yet";
        } else if (!t.group) {
          this.h.switcher.hint = `${t.name} is not in a group`;
        } else {
          this.groups.assignments[t.sessionId] = null;
          saveGroups(this.groups);
          this.refresh();
          this.h.switcher.hint = `${t.name} removed from ${t.group}`;
        }
      }),
      summarize: async (call, target) => {
        const model = (call.opts.model as string | undefined) ?? summaryModel();
        const chars = call.opts.chars as number | undefined;
        if (chars !== undefined && !(chars >= 200)) {
          this.h.switcher.hint = "summarize: --chars must be a number, at least 200";
          return;
        }
        if (this.summarizing) {
          this.h.switcher.hint = "summarize: already running - wait for it to finish";
          return;
        }
        this.summarizing = true;
        try {
          if (call.opts.all === true) {
            await this.summarizeAll(model, chars);
          } else if (!target) {
            this.h.switcher.hint = "summarize: highlight a session first";
          } else {
            this.h.switcher.hint = `summarizing ${target.name} with ${model} (a slow model can take minutes)...`;
            this.h.tui.requestRender();
            if (await this.summarizeOne(target, model, chars)) {
              this.h.switcher.hint = `summarized ${target.name}`;
            }
          }
        } finally {
          this.summarizing = false;
        }
      },
      filter: async (call) => {
        const text = call.args.join(" ");
        if (!text.trim()) {
          this.clearFilter();
          this.h.switcher.hint = "filter cleared";
          return;
        }
        const error = this.setFilter(text, call.opts.regex === true);
        this.h.switcher.hint = error ? `filter: ${error}` : "";
      },
      mouse: async (call) => this.h.setMouse(call.args[0] ?? ""),
      exit: leave,
      quit: leave,
      help: async () => {
        this.h.infoPanel.show(listing(SWITCHER_COMMANDS));
      },
      restore: async (call) => {
        await this.restoreFromTrash(call.args.join(" "));
      },
      adopt: async (_call, target) => {
        const t = target ?? this.h.switcher.current();
        if (!t) {
          this.h.switcher.hint = "adopt: highlight a session first";
        } else if (!t.key.startsWith("/")) {
          this.h.switcher.hint = "adopt: not a file-backed session";
        } else {
          try {
            const data = (await this.h.request({ type: "adopt", path: t.key, cwd: t.cwd ?? process.cwd() })) as {
              sessionId?: number;
            };
            if (typeof data?.sessionId === "number") {
              const meta = this.h.sessions.get(data.sessionId);
              if (meta) {
                this.h.viewing = this.h.keyFor(meta);
                this.close();
              } else {
                this.h.pendingEnterId = data.sessionId;
                this.h.switcher.hint = "adopting...";
              }
            }
          } catch (err) {
            this.h.switcher.hint = `adopt failed: ${err instanceof Error ? err.message : err}`;
          }
        }
      },
      "kill-daemon": async () => {
        this.h.send({ type: "shutdown" });
        this.h.switcher.hint = "daemon shutting down (children stop too)";
      },
    };
  }

  keys(data: string): boolean {
    if (this.liveFilter && this.liveFilterKeys(data)) {
      return true;
    }
    if (matchesKey(data, Key.ctrl("f"))) {
      this.startLiveFilter();
      return true;
    }
    const editorEmpty = this.h.editor.getText().trim().length === 0;
    if (matchesKey(data, Key.up) && editorEmpty) {
      this.h.switcher.move(-1);
      this.h.tui.requestRender();
      return true;
    }
    if (matchesKey(data, Key.down) && editorEmpty) {
      this.h.switcher.move(1);
      this.h.tui.requestRender();
      return true;
    }
    if (matchesKey(data, "shift+up")) {
      this.h.switcher.shiftMove(-1);
      return true;
    }
    if (matchesKey(data, "shift+down")) {
      this.h.switcher.shiftMove(1);
      return true;
    }
    if (matchesKey(data, Key.escape)) {
      // In the switcher, esc cancels the action in progress (a typed
      // command, else an active filter) - it never navigates. left is the "go back" key.
      if (this.h.editor.getText().trim().length > 0) {
        this.h.editor.setText("");
        this.h.switcher.hint = "";
      } else if (this.filter) {
        this.clearFilter();
        this.h.switcher.hint = "filter cleared";
        this.h.tui.requestRender();
      }
      return true;
    }
    // on a session, left is a no-op (furthest back level); on a group header it folds the group
    if (matchesKey(data, Key.left) && editorEmpty) {
      const here = this.h.switcher.current();
      if (this.h.switcher.currentIsHeader()) {
        this.setCollapsed(this.h.switcher.currentHeaderTitle(), true);
      } else if (here && (here.descendants ?? 0) > 0 && !this.isFolded(here)) {
        this.setSessionFolded(here, true);
      } else if (here?.parentId) {
        // like a file tree: left on a child goes up to its parent
        this.h.switcher.selectSessionId(here.parentId);
        this.h.tui.requestRender();
      }
      return true;
    }
    if (matchesKey(data, Key.right) && editorEmpty) {
      const target = this.h.switcher.current();
      if (target && (target.descendants ?? 0) > 0 && this.isFolded(target)) {
        this.setSessionFolded(target, false);
      } else if (target) {
        void this.enter(target);
      } else if (this.h.switcher.currentIsHeader()) {
        this.setCollapsed(this.h.switcher.currentHeaderTitle(), false);
      } else {
        this.h.switcher.hint = "nothing to open";
        this.h.tui.requestRender();
      }
      return true;
    }
    if (matchesKey(data, Key.ctrl("n"))) {
      void this.newSession();
      return true;
    }
    if (matchesKey(data, Key.ctrl("x"))) {
      if (this.h.switcher.currentIsHeader()) {
        void this.deleteGroupIfEmpty(this.h.switcher.currentHeaderTitle());
        return true;
      }
      const target = this.h.switcher.current();
      if (target) {
        void this.remove(target);
      }
      return true;
    }
    if (matchesKey(data, Key.ctrl("k"))) {
      const target = this.sessionRow("stop");
      if (target) {
        void this.stop(target);
      }
      return true;
    }
    if (isF2(data) || matchesKey(data, Key.ctrl("r"))) {
      const target = this.sessionRow("rename");
      if (target) {
        this.h.editor.setText(`/rename ${target.name}`);
        this.h.switcher.hint = "rename: edit the name and press enter";
      }
      return true;
    }
    if (matchesKey(data, Key.ctrl("g"))) {
      const target = this.sessionRow("group");
      if (target) {
        this.h.editor.setText(`/group ${target.group ?? ""}`);
        this.h.switcher.hint = `group: ${target.name} - edit or type a group name and press enter`;
      }
      return true;
    }
    return false;
  }

  private isFolded(s: SwitcherSession): boolean {
    return !this.filter && s.sessionId !== undefined && (this.groups.collapsed ?? []).includes(s.sessionId);
  }

  /** Fold or unfold the children of a session; remembered across runs (same list as folded groups). */
  private setSessionFolded(s: SwitcherSession, fold: boolean): void {
    if (this.filter) {
      this.h.switcher.hint = "children can't be folded while a filter is on";
      this.h.tui.requestRender();
      return;
    }
    if (!s.sessionId) {
      return;
    }
    const set = new Set(this.groups.collapsed);
    if (fold) {
      set.add(s.sessionId);
    } else {
      set.delete(s.sessionId);
    }
    this.groups.collapsed = [...set];
    saveGroups(this.groups);
    this.refresh();
  }

  /** Fold or unfold a group in the switcher; remembered across runs. */
  private setCollapsed(title: string, collapse: boolean): void {
    if (this.filter) {
      this.h.switcher.hint = "groups can't be folded while a filter is on";
      this.h.tui.requestRender();
      return;
    }
    if (collapse && this.h.switcher.currentHeaderEmpty()) {
      this.h.switcher.hint = `${title} is empty - nothing to fold (you can drag a session into it)`;
      this.h.tui.requestRender();
      return;
    }
    const set = new Set(this.groups.collapsed);
    if (collapse) {
      set.add(title);
    } else {
      set.delete(title);
    }
    this.groups.collapsed = [...set];
    saveGroups(this.groups);
    this.refresh();
    this.h.tui.requestRender();
  }

  /** The highlighted session row; on a group header (or nothing) it sets a hint saying `verb` needs a session. */
  private sessionRow(verb: string): SwitcherSession | undefined {
    const target = this.h.switcher.current();
    if (this.h.switcher.currentIsHeader() || !target) {
      this.h.switcher.hint = `${verb} works on sessions, not group headers`;
      return undefined;
    }
    return target;
  }


  /** Enter in the chat box while the switcher is open. */
  submit(trimmed: string): void {
    // The chat box doubles as the switcher's command line.
    this.h.editor.setText("");
    if (trimmed.startsWith("/")) {
      void this.runCommand(trimmed, this.h.switcher.current());
      return;
    }
    // plain text = the first message of a new session
    if (trimmed.length > 0) {
      void this.newSession(trimmed);
      return;
    }
    // enter opens the highlighted session; on a group header it folds or unfolds the group
    const target = this.h.switcher.current();
    if (target) {
      void this.enter(target);
      return;
    }
    const folded = this.h.switcher.currentHeaderFolded();
    if (folded !== undefined) {
      this.setCollapsed(this.h.switcher.currentHeaderTitle(), !folded);
    }
  }
}
