// Permission/extension dialogs forwarded from a child (confirm and select
// are answerable from the status line; input/editor are auto-denied).

export interface DialogRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
}

/**
 * Map a keypress to the extension_ui_response fields that answer `dialog`,
 * or null when the key is not an answer.
 */
export function dialogAnswer(dialog: DialogRequest, data: string): Record<string, unknown> | null {
  if (dialog.method === "confirm") {
    if (data === "y") {
      return { confirmed: true };
    }
    if (data === "n") {
      return { confirmed: false };
    }
    return null;
  }
  if (dialog.method === "select") {
    const options = dialog.options ?? [];
    const idx = Number.parseInt(data, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
      return { value: options[idx - 1] };
    }
    if (data === "\x1b") {
      return { cancelled: true };
    }
  }
  return null;
}

/** Status-line prompt for a pending dialog (unstyled). */
export function dialogPrompt(d: DialogRequest): string {
  if (d.method === "confirm") {
    return `PERMISSION: ${d.title ?? "confirm"}${d.message ? ` - ${d.message}` : ""}  [y]es [n]o`;
  }
  const opts = (d.options ?? []).map((o, i) => `${i + 1}:${o}`).join("  ");
  return `PERMISSION: ${d.title ?? "select"}  ${opts}`;
}
