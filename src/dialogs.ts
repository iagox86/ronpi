// Permission/extension dialogs forwarded from a child. confirm and select are
// answered from a docked panel; input/editor are answered by typing in the
// input box (pi-permission-system uses one for the optional deny reason).
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { attention, dim, panel, panelInnerWidth, selected } from "./theme.ts";

export interface DialogRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  /** Which session raised the dialog, e.g. "Session 3 'Worker'"; set by the controller. */
  origin?: string;
}

/**
 * Label a dialog request with the session that raised it. The numeric id
 * goes in because session names can repeat.
 */
export function withOrigin(d: DialogRequest, id: number, name?: string): DialogRequest {
  return { ...d, origin: name ? `Session ${id} '${name}'` : `Session ${id}` };
}

/** Free-text dialogs: answered by typing in the input box. */
export const isTextDialog = (d: DialogRequest): boolean => d.method === "input" || d.method === "editor";

/**
 * The option that means "deny": the first starting with "No", else the last.
 * A presentation heuristic - dismissal always means deny, and the option list
 * comes from the permission package, not the model.
 */
export function denyOption(options: string[]): string | undefined {
  return options.find((o) => o.startsWith("No")) ?? options[options.length - 1];
}

/**
 * Map a keypress to the extension_ui_response fields that answer `dialog`,
 * or null when the key is not an answer. `index` is the highlighted option.
 */
export function dialogAnswer(dialog: DialogRequest, data: string, index = 0): Record<string, unknown> | null {
  if (dialog.method === "confirm") {
    if (data === "y") {
      return { confirmed: true };
    }
    if (data === "n" || data === "\x1b") {
      return { confirmed: false };
    }
    return null;
  }
  if (dialog.method === "select") {
    const options = dialog.options ?? [];
    const idx = Number.parseInt(data, 10);
    if (data.length === 1 && !Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
      return { value: options[idx - 1] };
    }
    if (data === "\r" || data === "\n") {
      return options[index] === undefined ? null : { value: options[index] };
    }
    if (data === "\x1b") {
      const deny = denyOption(options);
      return deny === undefined ? { cancelled: true } : { value: deny };
    }
  }
  return null;
}

/** Status-line hint while a dialog is pending (unstyled). */
export function dialogPrompt(d: DialogRequest): string {
  const who = d.origin ? ` (${d.origin})` : "";
  if (d.method === "confirm") {
    return `PERMISSION pending${who} - y yes, n or esc no`;
  }
  if (isTextDialog(d)) {
    return `PERMISSION pending${who} - type a reply, enter send, esc skip`;
  }
  return `PERMISSION pending${who} - up/down choose, enter or 1-9 answer, tab reason, esc deny`;
}

/** Options that chain a free-text dialog afterwards ("No, provide reason"). */
export const takesReason = (option: string | undefined): boolean => /reason/i.test(option ?? "");

/** `reason` non-null = the highlighted option is being edited inline. */
export function dialogLines(d: DialogRequest, index: number, width: number, reason: string | null = null): string[] {
  const out: string[] = [];
  const title = (d.title ?? d.method).split("\n");
  const head = d.origin ? `${d.origin}: ` : "";
  out.push(attention(truncateToWidth(` ${head}${title[0]}`, width)));
  for (const line of title.slice(1)) {
    out.push(truncateToWidth(` ${line}`, width));
  }
  if (d.message) {
    out.push(truncateToWidth(` ${d.message}`, width));
  }
  if (d.method === "confirm") {
    out.push(dim(" [y]es  [n]o"));
    return out;
  }
  if (isTextDialog(d)) {
    out.push(dim(truncateToWidth(` ${d.placeholder ?? "type a reply in the box below"}`, width)));
    out.push(dim(" enter send - empty enter or esc skips"));
    return out;
  }
  (d.options ?? []).forEach((o, i) => {
    if (i === index && reason !== null) {
      out.push(selected(truncateToWidth(` > ${i + 1}. ${o}: ${reason}\u2588`, width)));
      return;
    }
    const hint = i === index && takesReason(o) ? "  (tab: type a reason)" : "";
    const text = truncateToWidth(` ${i + 1}. ${o}${hint}`, width - 2);
    out.push(i === index ? selected(` >${text}`) : dim(`  ${text}`));
  });
  return out;
}

/** Docked above the input box while the viewed session has a pending dialog. */
export class DialogPanel implements Component {
  private dialog: DialogRequest | undefined;
  private index = 0;
  private reason: string | null = null;

  /** Inline reason text while editing, else null. */
  get editing(): string | null {
    return this.reason;
  }

  edit(text: string | null): void {
    this.reason = text;
  }

  /** Show `dialog` (undefined hides); the highlight restarts for a new dialog. */
  sync(dialog: DialogRequest | undefined): void {
    if (dialog?.id !== this.dialog?.id) {
      this.index = 0;
      this.reason = null;
    }
    this.dialog = dialog;
  }

  get highlightedOption(): string | undefined {
    return this.dialog?.options?.[this.index];
  }

  get highlighted(): number {
    return this.index;
  }

  move(delta: number): void {
    this.reason = null;
    const n = this.dialog?.options?.length ?? 0;
    this.index = Math.max(0, Math.min(Math.max(0, n - 1), this.index + delta));
  }

  render(width: number): string[] {
    return this.dialog ? panel(dialogLines(this.dialog, this.index, panelInnerWidth(width), this.reason), width) : [];
  }

  invalidate(): void {}
}
