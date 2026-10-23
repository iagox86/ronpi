// Session-side actions of the controller: keys in the chat view, permission
// dialog answers, and prompting (including the fork-confirm and adopt flows).
import * as fs from "node:fs";
import * as path from "node:path";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { dialogAnswer } from "./dialogs.ts";
import { isPlainLeft } from "./editor.ts";
import { fmtAge } from "./format.ts";
import { rewindTargets } from "./rewind.ts";
import type { Host } from "./host.ts";
import { itemsFromFile, newView, type SessionView } from "./transcript.ts";

const DOUBLE_ESC_MS = 600;

export class SessionActions {
  /** Armed: prompting a recently-modified external session (fork warning). */
  armedFork: string | null = null;

  private readonly h: Host;
  private lastEsc = 0;

  constructor(host: Host) {
    this.h = host;
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
      const now = Date.now();
      // esc esc on an idle session with an empty editor = rewind
      if (now - this.lastEsc < DOUBLE_ESC_MS && !meta?.streaming && this.h.editor.getText().length === 0) {
        this.lastEsc = 0;
        this.openRewind();
        return true;
      }
      this.lastEsc = now;
      if (meta?.id !== undefined && meta.attachedToYou && meta.streaming) {
        this.h.send({ type: "abort", session: meta.id });
        this.h.notify("aborted");
      }
      return true;
    }
    if (isPlainLeft(data) && this.h.editor.getText().trim().length === 0) {
      this.h.switching.open();
      return true;
    }
    return false;
  }


  /** Open the rewind list for the viewed session. */
  private openRewind(): void {
    const key = this.h.viewing;
    if (!key || !fs.existsSync(key)) {
      this.h.notify("nothing to rewind yet");
      return;
    }
    const targets = rewindTargets(key);
    if (targets.length === 0) {
      this.h.notify("nothing to rewind yet");
      return;
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
      if (target) {
        void this.rewindTo(target.entryId);
      }
    }
    this.h.tui.requestRender();
    return true;
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
    const fields = dialogAnswer(dialog, data);
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

  submit(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (trimmed === "/exit") {
      this.h.dispose();
      return;
    }
    if (trimmed === "/quit") {
      this.h.switching.open();
      this.h.editor.setText("");
      return;
    }
    if (trimmed === "/abort") {
      const meta = this.h.viewing ? this.h.metaForPath(this.h.viewing) : undefined;
      if (meta?.id !== undefined && meta.attachedToYou) {
        this.h.send({ type: "abort", session: meta.id });
        this.h.notify("abort sent");
      } else {
        this.h.notify("nothing to abort here");
      }
      this.h.editor.setText("");
      return;
    }
    void this.prompt(trimmed);
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
    try {
      if (meta) {
        await this.h.request({ type: "prompt", session: meta.id, message: text });
      } else {
        const info = this.h.local.get(key);
        if (!key.startsWith("/") || !info) {
          this.h.notify("cannot start this session (no session file)");
          return false;
        }
        // The file may be open in an external (non-daemon) pi process -
        // undetectable directly, but a very recent mtime is a strong
        // signal. Prompting it forks the conversation (pi's tree
        // format keeps both branches), so confirm once.
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(key).mtimeMs;
        } catch {
          // stat failure: treat as old
        }
        const recent = Date.now() - mtimeMs < 60_000;
        if (recent && this.armedFork !== key) {
          this.armedFork = key;
          this.h.notify(
            `changed ${fmtAge(Date.now() - mtimeMs)} ago - may be open in another pi; enter again to FORK it and continue here, esc to cancel`,
          );
          this.h.editor.setText(text);
          return false;
        }
        this.armedFork = null;
        await this.h.request({
          type: "prompt",
          sessionFile: key,
          cwd: info.cwd || path.dirname(key),
          message: text,
        });
      }
      this.h.editor.addToHistory(text);
      this.h.editor.setText("");
      return true;
    } catch (err) {
      this.h.notify(`prompt failed: ${err instanceof Error ? err.message : err}`);
      this.h.editor.setText(text);
      return false;
    }
  }
}
