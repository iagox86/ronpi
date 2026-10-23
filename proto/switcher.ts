// The switcher: full-screen session browser, styled after Claude Code's
// agent list - a quiet two-column table (name | last activity) under dim
// group headers, selection shown by brightness alone. Rendered at a fixed
// height (the terminal's) with a tinted background so its bounds are always
// visible; content is windowed inside that. Input flows through the
// controller's chat box (the editor): this component only renders and moves.
import { spinnerFrame } from "./activity.ts";
import { appendFileSync } from "node:fs";
import { Container, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
import { fmtTokens, oneLine } from "./format.ts";
import {
  attention,
  paintLine,
  dim as themeDim,
  groupTitle,
  header,
  selected,
  streaming as streamingStyle,
} from "./theme.ts";

export type SessionState = "streaming" | "idle" | "inactive" | "dead";

export interface SwitcherSession {
  /** Canonical key: absolute session file path (or daemon:N before flush). */
  key: string;
  name: string;
  group?: string;
  state: SessionState;
  /** Daemon session id when the session is live. */
  daemonId?: number;
  /** Session UUID, for group assignments. */
  sessionId?: string;
  cwd?: string;
  note?: string;
  /** Preformatted age of the last request/response, e.g. "30s", "2h". */
  age?: string;
  /** Short model id, e.g. "glm-5.3-flash". */
  model?: string;
  /** Live in an external pi process: [pi] prefix + dimmed until selected. */
  muted?: boolean;
  /** First user message, shown in the description column when idle-ish. */
  description?: string;
}

const MARKERS: Record<SessionState, string> = {
  streaming: "*",
  idle: "·",
  inactive: "-",
  dead: "x",
};

const DESC_MIN = 20;
const dim = (s: string) => (s ? themeDim(s) : "");

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

type Row = { kind: "header"; title: string; count: number } | { kind: "session"; s: SwitcherSession };

export class Switcher extends Container implements Focusable {
  focused = false;
  sessions: SwitcherSession[] = [];
  groups: string[] = [];
  assignments: Record<string, string | null> = {};
  counts = { running: 0, waiting: 0 };
  /** Aggregate token/cost rollup across all sessions (daemon-tracked). */
  budget = { cost: 0, tokens: 0 };
  hint = "";
  /** Terminal rows; the controller injects a live provider (resize-safe). */
  height = 24;
  heightProvider?: () => number;

  onShiftSession?: (delta: number, s: SwitcherSession) => void;
  onShiftGroup?: (delta: number, title: string) => void;

  private rows: Row[] = [];
  private selRow = 0;
  selectedKey: string | null = null;
  /** Set when a group header is highlighted (group-reorder mode). */
  private selectedHeader: string | null = null;

  /** Rebuild rows, keeping the selection on the same session. */
  refresh(): void {
    const byGroup = new Map<string, SwitcherSession[]>();
    for (const s of this.sessions) {
      const g = s.group ?? "";
      const list = byGroup.get(g) ?? [];
      list.push(s);
      byGroup.set(g, list);
    }
    const ordered: SwitcherSession[] = [];
    const rows: Row[] = [];
    // Empty groups stay visible (deletable, usable as move targets).
    const pushGroup = (title: string, list: SwitcherSession[] | undefined) => {
      rows.push({ kind: "header", title, count: list?.length ?? 0 });
      for (const s of list ?? []) {
        rows.push({ kind: "session", s });
        ordered.push(s);
      }
    };
    pushGroup("(ungrouped)", byGroup.get(""));
    for (const g of this.groups) {
      pushGroup(g, byGroup.get(g));
    }
    if (this.debugLog) {
      try {
        appendFileSync(this.debugLog, `REFRESH rows=${rows.length} ordered=${ordered.length} selKey=${JSON.stringify(this.selectedKey)}\n`);
      } catch {
        // debug only
      }
    }
    this.rows = rows;
    this.sessions = ordered;
    if (this.selectedHeader !== null) {
      // Keep the grabbed header highlighted across its own reorder.
      const hr = rows.findIndex((r) => r.kind === "header" && r.title === this.selectedHeader);
      if (hr !== -1) {
        this.selRow = hr;
        return;
      }
      this.selectedHeader = null;
    }
    let at = ordered.findIndex((s) => s.key === this.selectedKey);
    if (at === -1) {
      // No/stale selection: default to the first session (row 0 is a header).
      this.selectedKey = ordered[0]?.key ?? null;
      at = 0;
    }
    this.selRow = ordered.length === 0 ? 0 : this.rowIndexOfSession(at);
  }

  /** Select the entry that follows `key` in display order (or the previous
   * one when it is last) - called before a delete so the cursor stays put. */
  selectNextAfter(key: string): void {
    const at = this.sessions.findIndex((s) => s.key === key);
    if (at === -1) {
      return;
    }
    const next = this.sessions[at + 1] ?? this.sessions[at - 1];
    if (next) {
      this.selectedKey = next.key;
      this.selectedHeader = null;
    }
  }

  /** Display-row index of the Nth session. */
  private rowIndexOfSession(sessionIdx: number): number {
    let seen = 0;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      if (row.kind === "session") {
        if (seen === sessionIdx) {
          return i;
        }
        seen++;
      }
    }
    return 0;
  }

  current(): SwitcherSession | undefined {
    const row = this.rows[this.selRow];
    return row?.kind === "session" ? row.s : undefined;
  }

  currentIsHeader(): boolean {
    return this.rows[this.selRow]?.kind === "header";
  }

  currentHeaderTitle(): string {
    const row = this.rows[this.selRow];
    return row?.kind === "header" ? row.title : "";
  }

  debugLog?: string;

  move(delta: number): void {
    // Headers ARE selectable: a highlighted header is how you grab a group
    // for shift+up/down reordering.
    const next = Math.max(0, Math.min(this.selRow + delta, this.rows.length - 1));
    if (this.debugLog) {
      try {
        appendFileSync(this.debugLog, `MOVE d=${delta} selRow=${this.selRow} rows=${this.rows.length} next=${next}\n`);
      } catch {
        // debug only
      }
    }
    if (next === this.selRow) {
      return;
    }
    this.selRow = next;
    const row = this.rows[next];
    if (row.kind === "session") {
      this.selectedKey = row.s.key;
      this.selectedHeader = null;
    } else {
      this.selectedKey = null;
      this.selectedHeader = row.title;
    }
  }

  /** shift+up/down on the current row: relocate a session or reorder a group. */
  shiftMove(delta: number): void {
    if (this.currentIsHeader()) {
      const title = this.currentHeaderTitle();
      if (title === "(ungrouped)") {
        this.hint = "(ungrouped) always stays on top";
        return;
      }
      this.selectedHeader = title;
      this.onShiftGroup?.(delta, title);
      return;
    }
    const s = this.current();
    if (s) {
      this.onShiftSession?.(delta, s);
    }
  }

  render(width: number): string[] {
    const height = Math.max(6, this.heightProvider?.() ?? this.height);
    const budget = Math.max(4, height - 6);

    // The session column is fixed at the longest name's width - names are
    // never cut. When the window is too narrow, columns drop in order:
    // summary first, then model. Age always stays.
    let maxName = 0;
    for (const s of this.sessions) {
      maxName = Math.max(maxName, visibleLen(`${MARKERS[s.state]} ${s.name}`) + 3);
    }
    const nameWidth = Math.max(18, maxName + 1);
    const hasModel = this.sessions.some((s) => s.model);
    const GAP = "    ";
    const ageW = 5;
    const modelW = 14;
    let showModel = hasModel;
    let showSummary = true;
    let summaryWidth =
      width - nameWidth - GAP.length - ageW - GAP.length - (showModel ? modelW + GAP.length : 0) - GAP.length;
    if (summaryWidth < DESC_MIN) {
      showModel = false;
      summaryWidth = width - nameWidth - GAP.length - ageW - GAP.length;
    }
    if (summaryWidth < DESC_MIN) {
      showSummary = false;
    }

    const lines: string[] = [];
    const budgetText =
      this.budget.cost > 0 ? ` \u00b7 $${this.budget.cost.toFixed(2)} \u00b7 ${fmtTokens(this.budget.tokens)} tok` : "";
    lines.push(dim(`ronpi  ${this.counts.running} running, ${this.counts.waiting} waiting on permission${budgetText}`));

    const labelCells: string[] = ["Session".padEnd(nameWidth), "Age".padEnd(ageW)];
    if (showModel) {
      labelCells.push("Model".padEnd(modelW));
    }
    if (showSummary) {
      labelCells.push("Summary");
    }
    lines.push(header(truncateToWidth(labelCells.join(GAP), width)));
    lines.push(dim("\u2500".repeat(width)));

    let start = 0;
    if (this.rows.length > budget) {
      start = Math.max(0, Math.min(this.selRow - Math.floor(budget / 2), this.rows.length - budget));
    }
    const visible = this.rows.slice(start, start + budget);
    for (let i = 0; i < budget; i++) {
      const row = visible[i];
      if (!row) {
        lines.push("");
        continue;
      }
      if (row.kind === "header") {
        const isSelHeader = this.selectedHeader === row.title && this.selectedKey === null;
        lines.push(isSelHeader ? selected(oneLine(row.title)) : groupTitle(oneLine(row.title)));
        continue;
      }
      const s = row.s;
      const isSel = s.key === this.selectedKey;
      const marker = s.note === "waiting on permission" ? attention("!") : s.state === "streaming" ? streamingStyle(spinnerFrame(Date.now())) : MARKERS[s.state];
      const markerText = isSel ? marker : dim(marker);
      const displayName = s.muted ? `[pi] ${oneLine(s.name)}` : oneLine(s.name);
      const bodyCell = truncateToWidth(displayName, nameWidth - 3).padEnd(nameWidth - 3);
      const body = !isSel && s.muted ? dim(bodyCell) : bodyCell;
      const ageCell = dim(truncateToWidth(s.age ?? "-", ageW).padEnd(ageW));
      let line = `${markerText}  ${body}`;
      line += GAP + ageCell;
      if (showModel) {
        const modelCell = dim(truncateToWidth(s.model ?? "-", modelW).padEnd(modelW));
        line += GAP + modelCell;
      }
      if (showSummary) {
        const desc = this.descriptionFor(s);
        if (desc) {
          line += GAP + dim(truncateToWidth(desc, Math.max(DESC_MIN, summaryWidth)));
        }
      }
      lines.push(isSel ? selected(line) : line);
    }

    lines.push("");
    lines.push(dim(truncateToWidth(this.hint, width)));

    // Pad to a constant height and tint every line so the switcher's bounds
    // are visible against whatever is behind it.
    while (lines.length < height) {
      lines.push("");
    }
    return lines.slice(0, height).map((line) => paintLine(line, width));
  }

  private descriptionFor(s: SwitcherSession): string {
    if (s.note === "waiting on permission" || s.note === "view-only") {
      return s.note;
    }
    if (s.state === "dead") {
      return "crashed - prompt respawns";
    }
    const desc = oneLine(s.description ?? "");
    if (desc) {
      return desc;
    }
    if (s.state === "inactive") {
      return "inactive";
    }
    return "working";
  }
}
