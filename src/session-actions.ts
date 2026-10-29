// Session-side actions of the controller: keys in the chat view, permission
// dialog answers, and prompting (including the fork-confirm and adopt flows).
import * as fs from "node:fs";
import * as path from "node:path";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { dialogAnswer, isTextDialog, takesReason } from "./dialogs.ts";
import { isPlainLeft } from "./editor.ts";
import { fmtAge } from "./format.ts";
import { TRASH_DIR } from "./config.ts";
import { latestClearBackup, rewindTargets } from "./rewind.ts";
import type { Host } from "./host.ts";
import { SessionCommands } from "./session-commands.ts";
import { itemsFromFile, newView, type SessionView } from "./transcript.ts";

const DOUBLE_ESC_MS = 600;
/** The daemon stops a command after 10 minutes; wait a little longer than that for its answer. */
const BANG_TIMEOUT_MS = 11 * 60_000;

export class SessionActions {
  /** Armed: prompting a recently-modified external session (fork warning). */
  armedFork: string | null = null;
  /** Session whose `!command` is running, so esc can stop it. */
  private bangSession: number | undefined;

  private readonly h: Host;
  private readonly commands: SessionCommands;
  private lastEsc = 0;

  constructor(host: Host) {
    this.h = host;
    this.commands = new SessionCommands(host);
  }

  resetArmed(): void {
    this.armedFork = null;
  }

  /** Keys in the chat view (the switcher is closed). */
  keys(data: string): boolean {
    if (matchesKey(data, Key.escape)) {
      // esc = interrupt the running agent (pi muscle memory); also
      // cancels an armed fork-confirm
      this.armedFork = null;
      const meta = this.h.viewing ? this.h.metaForPath(this.h.viewing) : undefined;
      const view = this.h.viewing ? this.h.views.get(this.h.viewing) : undefined;
      // A prompt just sent is working before the daemon reports streaming
      const working = Boolean(meta?.streaming) || (view?.echoes.length ?? 0) > 0;
      const now = Date.now();
      if (this.bangSession !== undefined && !working) {
        this.h.send({ type: "abort_bash", session: this.bangSession });
        return true;
      }
      if (working) {
        // esc while working only ever interrupts; it never arms the rewind double-tap
        this.lastEsc = 0;
        if (meta?.id !== undefined && meta.attachedToYou) {
          void this.abortRestoringQueue(meta.id);
        }
        return true;
      }
      // esc esc on an idle session with an empty editor = rewind
      if (now - this.lastEsc < DOUBLE_ESC_MS && this.h.editor.getText().length === 0) {
        this.lastEsc = 0;
        this.openRewind();
        return true;
      }
      this.lastEsc = now;
      return true;
    }
    if (matchesKey(data, Key.up) && this.h.editor.getText().length === 0) {
      const meta = this.h.viewing ? this.h.metaForPath(this.h.viewing) : undefined;
      const view = this.h.viewing ? this.h.views.get(this.h.viewing) : undefined;
      if (meta?.id !== undefined && meta.attachedToYou && (view?.queue.length ?? 0) > 0) {
        void this.unqueue(meta.id);
        return true;
      }
      return false; // history
    }
    if (isPlainLeft(data) && this.h.editor.getText().trim().length === 0) {
      this.h.switching.open();
      return true;
    }
    return false;
  }


  /**
   * Abort the run. Messages still queued are pulled back into the editor
   * first (pi's own Esc behavior) - an abort alone would go on to deliver them.
   */
  private async abortRestoringQueue(session: number): Promise<void> {
    const queued = await this.takeQueue(session);
    this.h.send({ type: "abort", session });
    this.restoreQueued(queued, "aborted", "\n\n");
  }

  /** Up in an empty box with messages queued: pull them back into the editor. */
  private async unqueue(session: number): Promise<void> {
    const queued = await this.takeQueue(session);
    if (queued.length > 0) {
      this.restoreQueued(queued, "unqueued", "\n");
    }
  }

  /** Drop pi's queued steering/follow-up messages and return their text. */
  private async takeQueue(session: number): Promise<string[]> {
    try {
      const q = (await this.h.request({ type: "clear_queue", session })) as { steering?: string[]; followUp?: string[] };
      return [...(q.steering ?? []), ...(q.followUp ?? [])];
    } catch {
      return []; // queue state unknown
    }
  }

  private restoreQueued(queued: string[], verb: string, separator: string): void {
    const view = this.h.viewing ? this.h.views.get(this.h.viewing) : undefined;
    if (view) {
      view.queue = [];
    }
    if (queued.length > 0) {
      this.h.editor.setText([...queued, this.h.editor.getText()].filter((t) => t.trim()).join(separator));
      this.h.notify(`${verb} - ${queued.length} queued message${queued.length === 1 ? "" : "s"} back in the editor`);
    } else {
      this.h.notify(verb);
    }
    this.h.tui.requestRender();
  }

  /** Open the rewind list for the viewed session. */
  private openRewind(): void {
    const key = this.h.viewing;
    if (!key || !fs.existsSync(key)) {
      this.h.notify("nothing to rewind yet");
      return;
    }
    let targets = rewindTargets(key);
    if (targets.length === 0) {
      // an emptied session offers to undo its /clear instead
      const backup = latestClearBackup(TRASH_DIR, key);
      if (!backup) {
        this.h.notify("nothing to rewind yet");
        return;
      }
      targets = [
        {
          entryId: "",
          text: `Restore the ${backup.entries} entries cleared from this session`,
          ts: 0,
          restore: { entries: backup.entries, trashedAt: backup.trashedAt },
        },
      ];
    }
    this.h.rewindPicker.open(targets);
    this.h.tui.requestRender();
  }

  /** Keys while the rewind list is open; it swallows everything. */
  pickerKeys(data: string): boolean {
    const picker = this.h.rewindPicker;
    if (matchesKey(data, Key.escape)) {
      picker.close();
    } else if (matchesKey(data, Key.up)) {
      picker.move(-1);
    } else if (matchesKey(data, Key.down)) {
      picker.move(1);
    } else if (matchesKey(data, Key.enter)) {
      const target = picker.current();
      picker.close();
      if (target?.restore) {
        void this.restoreCleared();
      } else if (target) {
        void this.rewindTo(target.entryId);
      }
    }
    this.h.tui.requestRender();
    return true;
  }

  private async restoreCleared(): Promise<void> {
    const key = this.h.viewing;
    if (!key) {
      return;
    }
    const meta = this.h.metaForPath(key);
    try {
      await this.h.request(meta ? { type: "restore_clear", session: meta.id } : { type: "restore_clear", path: key });
      const cwd = meta?.cwd ?? this.h.local.get(key)?.cwd ?? process.cwd();
      this.h.views.set(key, { ...newView(), items: itemsFromFile(key, this.h.tui, cwd) });
      this.h.summaries.delete(key);
      this.h.rebuildChat();
      this.h.syncHistory(true);
      this.h.notify("restored the cleared conversation");
      void this.h.loadLocal();
    } catch (err) {
      this.h.notify(`restore failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async rewindTo(entryId: string): Promise<void> {
    const key = this.h.viewing;
    if (!key) {
      return;
    }
    const meta = this.h.metaForPath(key);
    try {
      const r = (await this.h.request(
        meta ? { type: "rewind", session: meta.id, entryId } : { type: "rewind", path: key, entryId },
      )) as { text: string; removed: number };
      const cwd = meta?.cwd ?? this.h.local.get(key)?.cwd ?? process.cwd();
      this.h.views.set(key, { ...newView(), items: itemsFromFile(key, this.h.tui, cwd) });
      this.h.summaries.delete(key);
      this.h.rebuildChat();
      this.h.syncHistory(true); // the removed messages are no longer history
      this.h.editor.setText(r.text);
      this.h.notify(`rewound - ${r.removed} entries moved to trash`);
      void this.h.loadLocal();
    } catch (err) {
      this.h.notify(`rewind failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Returns true when the key was consumed as a dialog answer. */
  dialogKeys(view: SessionView, data: string): boolean {
    const dialog = view.dialog!;
    if (!this.h.viewing) {
      return false;
    }
    const meta = this.h.metaForPath(this.h.viewing);
    if (!meta?.attachedToYou) {
      return false;
    }
    if (isTextDialog(dialog)) {
      const skip = matchesKey(data, Key.escape);
      if (!skip && !matchesKey(data, Key.enter)) {
        return false; // typing goes to the input box
      }
      const text = skip ? "" : this.h.editor.getText().trim();
      this.h.editor.setText("");
      this.h.send({
        type: "ui_response",
        session: meta.id,
        response: { type: "extension_ui_response", id: dialog.id, ...(text ? { value: text } : { cancelled: true }) },
      });
      view.dialog = undefined;
      this.h.renderChrome();
      return true;
    }
    const panel = this.h.dialogPanel;
    if (dialog.method === "select" && this.inlineReason(view, meta.id, data)) {
      return true;
    }
    if (dialog.method === "select" && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
      panel.move(matchesKey(data, Key.up) ? -1 : 1);
      this.h.renderChrome();
      return true;
    }
    // normalize enter/esc across keyboard protocols to what dialogAnswer expects
    let raw = data;
    if (matchesKey(data, Key.enter)) {
      raw = "\r";
    } else if (matchesKey(data, Key.escape)) {
      raw = "\x1b";
    }
    const fields = dialogAnswer(dialog, raw, panel.highlighted);
    if (!fields) {
      return false;
    }
    this.h.send({
      type: "ui_response",
      session: meta.id,
      response: { type: "extension_ui_response", id: dialog.id, ...fields },
    });
    view.dialog = undefined;
    this.h.renderChrome();
    return true;
  }

  /**
   * Tab on a "provide reason" option types the reason inline. The reason is
   * held on the view and answers the input dialog the package chains after the
   * select. Returns true when the key was consumed.
   */
  private inlineReason(view: SessionView, session: number, data: string): boolean {
    const panel = this.h.dialogPanel;
    const dialog = view.dialog!;
    const text = panel.editing;
    if (text === null) {
      if (matchesKey(data, Key.tab) && takesReason(panel.highlightedOption)) {
        panel.edit("");
        this.h.renderChrome();
        return true;
      }
      return false;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.escape)) {
      panel.edit(null);
    } else if (matchesKey(data, Key.enter)) {
      const value = panel.highlightedOption;
      const reason = text.trim();
      if (value === undefined) {
        return true;
      }
      view.pendingReason = reason ? { text: reason, at: Date.now() } : undefined;
      panel.edit(null);
      this.h.send({
        type: "ui_response",
        session,
        response: { type: "extension_ui_response", id: dialog.id, value },
      });
      view.dialog = undefined;
    } else if (matchesKey(data, Key.backspace)) {
      panel.edit(text.slice(0, -1));
    } else if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data) && !data.startsWith("\x1b")) {
      panel.edit(text + data);
    }
    this.h.renderChrome();
    return true;
  }

  submit(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (trimmed.startsWith("/") && this.commands.run(trimmed)) {
      return;
    }
    if (trimmed.startsWith("!")) {
      void this.bang(trimmed);
      return;
    }
    void this.prompt(trimmed);
  }

  /** Put `text` back in the box after a failed send, unless the user has already typed something new (then it stays reachable with up-arrow). */
  private giveBack(text: string): void {
    if (this.h.editor.getText().trim() === "") {
      this.h.editor.setText(text);
    } else {
      this.h.editor.addToHistory(text);
      this.h.notify("not sent - it is in the up-arrow history");
    }
  }

  /**
   * `!command`: the daemon runs it in the session's directory and tells the
   * agent the result at once (see local-command.ts); the command block appears
   * in the transcript when that message does. `!!` (output hidden from the
   * agent) is not offered.
   */
  private async bang(line: string): Promise<void> {
    const command = line.slice(1).trim();
    if (line.startsWith("!!")) {
      this.h.notify("!! is not supported - use ! (the agent sees the output)");
      return;
    }
    if (!this.h.viewing || !command) {
      this.h.notify("!<command> runs a shell command here and shows its output to the agent");
      return;
    }
    // a sleeping session is started first (no message needed), like /model or /compact do
    this.h.editor.setText("");
    const meta = await this.commands.liveMeta();
    if (!meta) {
      this.giveBack(line); // not started: keep the line so it can be retried
      return;
    }
    if (meta.attachedElsewhere || !meta.attachedToYou) {
      this.h.notify("view-only: this session is attached in another controller");
      return;
    }
    this.h.notify(`running: ${command} (esc stops it)`);
    this.bangSession = meta.id;
    try {
      await this.h.request({ type: "bash", session: meta.id, command }, BANG_TIMEOUT_MS);
      this.h.notify("");
    } catch (err) {
      this.h.notify(`!${command}: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.bangSession = undefined;
      this.h.renderChrome();
    }
  }

  /** /adopt the given session file, then deliver `text` to the fork once
   * entered. The prompt replays from pendingPrompt if the session metadata
   * has not arrived yet. */
  private async adoptAndPrompt(key: string, cwd: string, text: string): Promise<void> {
    try {
      const data = (await this.h.request({ type: "adopt", path: key, cwd })) as {
        sessionId?: number;
      };
      if (typeof data?.sessionId !== "number") {
        throw new Error("no session id");
      }
      const meta = this.h.sessions.get(data.sessionId);
      if (meta) {
        this.h.viewing = this.h.keyFor(meta);
        await this.prompt(text);
      } else {
        this.h.pendingEnterId = data.sessionId;
        this.h.pendingPrompt = text;
      }
    } catch (err) {
      this.h.notify(`fork failed: ${err instanceof Error ? err.message : err}`);
      this.h.editor.setText(text);
    }
  }

  async prompt(text: string): Promise<boolean> {
    const key = this.h.viewing;
    if (!key) {
      return false;
    }
    const meta = this.h.metaForPath(key);
    if (meta?.attachedElsewhere) {
      this.h.notify("view-only: this session is attached in another controller");
      return false;
    }
    if (meta?.externallyLive && meta.active) {
      // double-open: ronpi owns a live child AND a plain pi has the same
      // file open - forking cannot help, two writers would diverge
      this.h.notify("open in both ronpi and another pi - close one before prompting here");
      this.h.editor.setText(text);
      return false;
    }
    if (meta?.externallyLive) {
      if (this.armedFork !== key) {
        this.armedFork = key;
        this.h.notify(
          "live in another pi - continuing here FORKS the conversation (pi keeps its copy). enter again to fork and continue here, esc to cancel",
        );
        this.h.editor.setText(text);
        return false;
      }
      this.armedFork = null;
      const cwd = meta.cwd || path.dirname(key);
      void this.adoptAndPrompt(key, cwd, text);
      return true;
    }
    // Show the prompt now rather than when pi echoes it back. Slash lines may be
    // handled by an extension without ever becoming a message, and a prompt sent
    // mid-run is shown in the queue strip instead.
    // pasted images ride with the message; the markers that stood for them leave the text
    const { text: message, images } = text.startsWith("/") ? { text, images: [] } : this.h.attachments.take(text);
    if (images.length > 0 && meta?.acceptsImages === false) {
      this.h.notify(`${meta.model.split("/").pop()} does not take images - delete the [image] marker or switch model (/model)`);
      this.h.editor.setText(text);
      return false;
    }
    const sent = message || (images.length > 0 ? "(see the attached image)" : message);
    const echo = !text.startsWith("/") && !meta?.streaming;
    try {
      if (meta) {
        if (echo) {
          this.h.echoPrompt(key, sent);
        }
        await this.h.request({ type: "prompt", session: meta.id, message: sent, images: images.length > 0 ? images : undefined });
      } else {
        const info = this.h.local.get(key);
        if (!key.startsWith("/") || !info) {
          this.h.notify("cannot start this session (no session file)");
          return false;
        }
        // The file may be open in an external (non-daemon) pi process -
        // undetectable from here, so the daemon decides: it refuses files a
        // presence-covered pi holds, and flags brand-new recently-modified
        // files (a fork risk) with a confirmFork response instead of
        // touching them. Files it has handled before are ronpi's own and
        // just continue, whatever their mtime (a resume makes them look
        // freshly written).
        const data = (await this.h.request({
          type: "prompt",
          sessionFile: key,
          cwd: info.cwd || path.dirname(key),
          message: sent,
          images: images.length > 0 ? images : undefined,
          confirmFork: this.armedFork === key,
        })) as { confirmFork?: boolean; ageMs?: number } | undefined;
        if (data?.confirmFork) {
          this.armedFork = key;
          this.h.notify(
            `changed ${fmtAge(data.ageMs ?? 0)} ago - may be open in another pi; enter again to continue here (the conversation may fork), esc to cancel`,
          );
          this.h.editor.setText(text);
          return false;
        }
        this.armedFork = null;
        if (echo) {
          this.h.echoPrompt(key, sent);
        }
        await this.h.request({
          type: "prompt",
          sessionFile: key,
          cwd: info.cwd || path.dirname(key),
          message: sent,
          images: images.length > 0 ? images : undefined,
        });
      }
      this.h.editor.addToHistory(message);
      // starting a sleeping session takes seconds: only clear the box if it still holds what was sent,
      // not something typed meanwhile
      if (this.h.editor.getText() === text) {
        this.h.editor.setText("");
      }
      return true;
    } catch (err) {
      this.h.dropEcho(key, sent);
      this.h.notify(`prompt failed: ${err instanceof Error ? err.message : err}`);
      // give the images back, under fresh markers, so the message can be sent again
      this.giveBack([message, ...images.map((image) => this.h.attachments.put(image))].join(" "));
      return false;
    }
  }
}
