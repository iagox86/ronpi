// Switcher-side actions of the controller: opening/closing the list, row
// actions (enter/new/kill/rename/group/move), the command line and its keys.
import * as fs from "node:fs";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { parseCommand } from "./commands.ts";
import type { Host } from "./host.ts";
import { loadGroups, resolveGroup, saveGroups, type GroupsFile } from "./groups.ts";
import {
  buildSessionList,
  deleteEmptyGroup,
  moveGroup,
  moveSession,
  sortSessions,
  type MutationResult,
} from "./session-list.ts";
import type { SwitcherSession } from "./switcher.ts";
import { itemsFromFile, newView } from "./transcript.ts";

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
    this.h.switcher.hint = "type / for commands - enter open - ctrl-n new - ctrl-x kill - ctrl-r rename - ctrl-g group";
    this.h.switcher.heightProvider = () => Math.max(6, (this.h.tui.terminal.rows || 24) - 4);
    this.isOpen = true;
    this.h.tui.setLayoutRoot(this.h.switcherLayout);
    this.h.editor.setText("");
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
    if (process.env.RONPI_KEYS) {
      try {
        fs.appendFileSync(process.env.RONPI_KEYS, `REFRESH_SWITCHER paths=${list.length} local=${this.h.local.size} daemon=${this.h.sessions.size}: ${list.map((x) => x.key.split("/").pop()).join(",")}\n`);
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

  async newSession(): Promise<void> {
    try {
      const data = (await this.h.request({ type: "spawn", cwd: process.cwd() })) as { sessionId?: number };
      if (typeof data?.sessionId === "number") {
        const meta = this.h.sessions.get(data.sessionId);
        if (meta) {
          this.h.viewing = this.h.keyFor(meta);
          this.close();
        } else {
          this.h.pendingEnterId = data.sessionId;
          this.h.switcher.hint = "starting session...";
        }
      }
    } catch (err) {
      this.h.switcher.hint = `spawn failed: ${err instanceof Error ? err.message : err}`;
      this.h.tui.requestRender();
    }
  }

  async kill(s: SwitcherSession): Promise<void> {
    try {
      if (s.state === "streaming" || s.state === "idle") {
        if (s.daemonId === undefined) {
          throw new Error("no daemon session");
        }
        await this.h.request({ type: "deactivate", session: s.daemonId });
        this.h.switcher.hint = `deactivated ${s.name} (file kept; respawns on next prompt)`;
      } else {
        // inactive or dead: delete = trash, with a press-twice confirm
        if (this.armedDelete !== s.key) {
          this.armedDelete = s.key;
          this.h.switcher.hint = `${s.name}: press ctrl-x again to move to trash`;
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
      }
      this.refresh();
    } catch (err) {
      this.h.switcher.hint = `kill failed: ${err instanceof Error ? err.message : err}`;
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
    const { name, arg } = parseCommand(cmd);
    switch (name) {
      case "new":
        await this.newSession();
        break;
      case "kill":
        if (!target) {
          this.h.switcher.hint = "kill: highlight a session first";
        } else {
          await this.kill(target);
        }
        break;
      case "rename": {
        if (!target) {
          this.h.switcher.hint = "rename: highlight a session first";
        } else if (!arg) {
          this.h.editor.setText("/rename ");
          this.h.switcher.hint = `rename: ${target.name} - type the new name and press enter`;
        } else {
          try {
            await this.h.request({
              type: "rename",
              session: target.daemonId,
              path: target.daemonId === undefined ? target.key : undefined,
              name: arg,
            });
            await this.h.loadLocal();
            this.refresh();
            this.h.switcher.hint = `renamed to ${arg}`;
          } catch (err) {
            this.h.switcher.hint = `rename failed: ${err instanceof Error ? err.message : err}`;
          }
        }
        break;
      }
      case "group": {
        if (!target) {
          this.h.switcher.hint = "group: highlight a session first";
        } else if (!arg) {
          this.h.editor.setText("/group ");
          this.h.switcher.hint = `group: ${target.name} - type a group name and press enter`;
        } else if (!target.sessionId) {
          this.h.switcher.hint = "group: session has no id yet";
        } else {
          try {
            const group = resolveGroup(this.groups, arg);
            this.groups.assignments[target.sessionId] = group;
            saveGroups(this.groups);
            this.refresh();
            this.h.switcher.hint = `${target.name} -> ${group}`;
          } catch (err) {
            this.h.switcher.hint = `group failed: ${err instanceof Error ? err.message : err}`;
          }
        }
        break;
      }
      case "exit":
      case "quit":
        this.h.dispose();
        break;
      case "help":
        this.h.switcher.hint = "/new /kill /rename <name> /group <name> /adopt /kill-daemon /exit /help";
        break;
      case "restore":
        this.h.switcher.hint = "/restore is not built yet (trash keeps everything)";
        break;
      case "adopt": {
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
        break;
      }
      case "kill-daemon":
        this.h.send({ type: "shutdown" });
        this.h.switcher.hint = "daemon shutting down (children stop too)";
        break;
      default:
        this.h.switcher.hint = `unknown command: /${name} (/help)`;
    }
    this.h.tui.requestRender();
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
        void this.kill(target);
      }
      return true;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
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
    // enter opens the highlighted session; on a group header it is a no-op
    const target = this.h.switcher.current();
    if (target) {
      void this.enter(target);
    }
  }
}
