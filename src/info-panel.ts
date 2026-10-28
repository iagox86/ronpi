// A docked, dismissable text panel for multi-line command output (--help,
// /help). Shares the popup look of the dialog and rewind panels.
import type { Component } from "@earendil-works/pi-tui";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { dim, panel, panelInnerWidth } from "./theme.ts";

export interface PanelAction {
  key: string;
  label: string;
  run: () => void;
}

export class InfoPanel implements Component {
  private lines: string[] = [];
  private actions: PanelAction[] = [];

  get isOpen(): boolean {
    return this.lines.length > 0;
  }

  /** `actions` add single-key choices (shown in the footer) next to the usual "any key closes". */
  show(text: string, actions: PanelAction[] = []): void {
    this.lines = text.split("\n");
    this.actions = actions;
  }

  close(): void {
    this.lines = [];
    this.actions = [];
  }

  /** Runs the action bound to `data` and closes the panel; false when the key is not one of them. */
  act(data: string): boolean {
    const action = this.actions.find((a) => a.key === data);
    if (!action) {
      return false;
    }
    this.close();
    action.run();
    return true;
  }

  render(width: number): string[] {
    if (!this.isOpen) {
      return [];
    }
    const inner = panelInnerWidth(width);
    const body = this.lines.flatMap((l) => wrapTextWithAnsi(` ${l}`, inner));
    const keys = this.actions.map((a) => `${a.key} ${a.label}`).join(", ");
    return panel([...body, "", dim(` ${keys ? `${keys} - ` : ""}esc or enter closes`)], width);
  }

  invalidate(): void {}
}
