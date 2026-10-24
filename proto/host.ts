// What the action classes need from the Controller. The Controller satisfies
// this structurally; keeping it as an interface makes the dependency explicit
// and lets the action classes be read (and later tested) on their own.
import type { InputEditor } from "./editor.ts";
import type { SessionMeta, ClientCommand, DistributiveOmit } from "./shared.ts";
import type { LocalSession } from "./session-list.ts";
import type { Switcher } from "./switcher.ts";
import type { RewindPicker } from "./rewind-picker.ts";
import type { DialogPanel } from "./dialogs.ts";
import type { InfoPanel } from "./info-panel.ts";
import type { SessionView } from "./transcript.ts";
import type { SessionActions } from "./session-actions.ts";
import type { SwitcherActions } from "./switcher-actions.ts";
import type { TuiAltScreen, VStack } from "@earendil-works/pi-tui";

export interface Host {
  tui: TuiAltScreen;
  editor: InputEditor;
  switcher: Switcher;
  chatLayout: VStack;
  switcherLayout: VStack;
  /** Daemon-known sessions by daemon id. */
  sessions: Map<number, SessionMeta>;
  /** Sessions from the filesystem, by session file path. */
  local: Map<string, LocalSession>;
  views: Map<string, SessionView>;
  summaries: Map<string, string>;
  /** Path key of the session on screen; null = none (switcher behind). */
  viewing: string | null;
  /** Spawn/adopt resolved by the daemon's next session list: enter it then. */
  pendingEnterId: number | null;
  /** Text to send once pendingEnterId resolves (adopt-then-prompt flow). */
  pendingPrompt: string | null;
  rewindPicker: RewindPicker;
  dialogPanel: DialogPanel;
  infoPanel: InfoPanel;
  switching: SwitcherActions;
  session: SessionActions;
  request(cmd: DistributiveOmit<ClientCommand, "id">, timeoutMs?: number): Promise<unknown>;
  send(msg: Record<string, unknown>): void;
  keyFor(meta: SessionMeta): string;
  metaForPath(key: string): SessionMeta | undefined;
  loadLocal(): Promise<void>;
  rebuildChat(): void;
  syncHistory(force?: boolean): void;
  /** Show a sent prompt immediately in the session's transcript (and start the spinner). */
  echoPrompt(key: string, text: string): void;
  /** Undo echoPrompt when the send failed. */
  dropEcho(key: string, text: string): void;
  notify(message: string): void;
  renderChrome(): void;
  dispose(): void;
}
