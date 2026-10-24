// Switcher-side actions of the controller: opening/closing the list, row
// actions (enter/new/kill/rename/group/move), the command line and its keys.
import * as fs from "node:fs";
import { KEY_LOG } from "./config.ts";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { type Invocation, listing, parseCommandLine } from "./cli.ts";
import { SWITCHER_COMMANDS, type SwitcherCommandName } from "./commands.ts";
import type { Host } from "./host.ts";
import { loadGroups, resolveGroup, saveGroups, type GroupsFile } from "./groups.ts";
import {
  buildSessionList,
  appendUnranked,
  deleteEmptyGroup,
  moveGroup,
  moveSession,
  sortSessions,
  type MutationResult,
} from "./session-list.ts";
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
    this.switchOrder = null;
    this.armedDelete = null;
    this.lastRefused = null;
    this.h.session.resetArmed();
    // Land on the session we were just in, else the first session.
    this.h.switcher.selectedKey = this.h.viewing;
    this.refresh();
    this.h.switcher.height = this.h.tui.terminal.rows || 24;
    this.h.switcher.hint = "type / for commands, or a message to start a session - enter open - ctrl-n new - ctrl-k stop - ctrl-x delete - ctrl-r rename - ctrl-g group";
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
    this.h.tui.setLayoutRoot(this.h.chatLayout);
    this.h.rebuildChat();
    this.h.renderChrome();
    this.h.tui.requestRender(true);
  }

  refresh(): void {
    this.groups = loadGroups();
    const list = buildSessionList({
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
    const order = appendUnranked(this.groups.order, list);
    if (order) {
      this.groups.order = order;
      saveGroups(this.groups);
    }
    if (KEY_LOG) {
      try {
        fs.appendFileSync(KEY_LOG, `REFRESH_SWITCHER paths=${list.length} local=${this.h.local.size} daemon=${this.h.sessions.size}: ${list.map((x) => x.key.split("/").pop()).join(",")}\n`);
      } catch {
        // debug only
      }
    }
    this.h.switcher.sessions = list;
    this.h.switcher.groups = this.groups.groups;
    this.h.switcher.height = this.h.tui.terminal.rows || 24;
    this.h.switcher.refresh();
    this.h.tui.requestRender();
  }

  async enter(s: SwitcherSession): Promise<void> {
    if (s.daemonId !== undefined && (s.state === "streaming" || s.state === "idle")) {
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
  async newSession(firstMessage?: string): Promise<void> {
    try {
      const data = (await this.h.request({ type: "spawn", cwd: process.cwd() })) as { sessionId?: number };
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
      if (s.state !== "streaming" && s.state !== "idle") {
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
  async remove(s: SwitcherSession): Promise<void> {
    try {
      if (this.armedDelete !== s.key) {
        this.armedDelete = s.key;
        const live = s.state === "streaming" || s.state === "idle";
        this.h.switcher.hint = `${s.name}: press ctrl-x again to ${live ? "stop it and " : ""}move to trash`;
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
      this.h.switcher.hint = `${s.name} moved to trash (/restore not built yet)`;
      this.refresh();
    } catch (err) {
      this.h.switcher.hint = `delete failed: ${err instanceof Error ? err.message : err}`;
    }
    this.h.tui.requestRender();
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
    this.applyGroupChange(moveSession(this.groups, this.h.switcher.sessions, s, delta));
  }

  /** shift+up/down on a group header: swap with the neighboring group. */
  async moveGroup(delta: number, title: string): Promise<void> {
    this.applyGroupChange(moveGroup(this.groups, title, delta));
  }

  /** ctrl-x on a group header: delete it (only when it has no sessions). */
  async deleteGroupIfEmpty(title: string): Promise<void> {
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
    const needsTarget = (verb: string, run: (t: SwitcherSession, arg: string) => Promise<void>) =>
      async (call: Invocation, target: SwitcherSession | undefined) => {
        if (!target) {
          this.h.switcher.hint = `${verb}: highlight a session first`;
          return;
        }
        await run(target, call.args.join(" "));
      };
    const leave = async () => {
      this.h.dispose();
    };
    return {
      new: async () => this.newSession(),
      stop: needsTarget("stop", (t) => this.stop(t)),
      delete: needsTarget("delete", (t) => this.remove(t)),
      rename: needsTarget("rename", async (t, arg) => {
        if (!arg) {
          this.h.editor.setText("/rename ");
          this.h.switcher.hint = `rename: ${t.name} - type the new name and press enter`;
          return;
        }
        try {
          await this.h.request({
            type: "rename",
            session: t.daemonId,
            path: t.daemonId === undefined ? t.key : undefined,
            name: arg,
          });
          await this.h.loadLocal();
          this.refresh();
          this.h.switcher.hint = `renamed to ${arg}`;
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
      exit: leave,
      quit: leave,
      help: async () => {
        this.h.infoPanel.show(listing(SWITCHER_COMMANDS));
      },
      restore: async () => {
        this.h.switcher.hint = "/restore is not built yet (trash keeps everything)";
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
      // command) - it never navigates. left is the "go back" key.
      if (this.h.editor.getText().trim().length > 0) {
        this.h.editor.setText("");
        this.h.switcher.hint = "";
      }
      return true;
    }
// left is a no-op in the switcher (furthest back level)

    if (matchesKey(data, Key.right) && editorEmpty) {
      const target = this.h.switcher.current();
      if (target) {
        void this.enter(target);
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
      const target = this.h.switcher.current();
      if (this.h.switcher.currentIsHeader() || !target) {
        this.h.switcher.hint = "stop works on sessions, not group headers";
      } else {
        void this.stop(target);
      }
      return true;
    }
    if (isF2(data) || matchesKey(data, Key.ctrl("r"))) {
      const target = this.h.switcher.current();
      if (this.h.switcher.currentIsHeader() || !target) {
        this.h.switcher.hint = "rename works on sessions, not group headers";
      } else {
        this.h.editor.setText(`/rename ${target.name}`);
        this.h.switcher.hint = "rename: edit the name and press enter";
      }
      return true;
    }
    if (matchesKey(data, Key.ctrl("g"))) {
      const target = this.h.switcher.current();
      if (this.h.switcher.currentIsHeader() || !target) {
        this.h.switcher.hint = "group works on sessions, not group headers";
      } else {
        this.h.editor.setText(`/group ${target.group ?? ""}`);
        this.h.switcher.hint = `group: ${target.name} - edit or type a group name and press enter`;
      }
      return true;
    }
    return false;
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
    // enter opens the highlighted session; on a group header it is a no-op
    const target = this.h.switcher.current();
    if (target) {
      void this.enter(target);
    }
  }
}
