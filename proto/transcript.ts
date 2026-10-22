// The transcript model: one renderer for both live event streams and replays
// of session files, so the two views cannot drift apart. Items are pi's own
// message/tool components; this module builds and updates them.
import * as fs from "node:fs";
import { Text, type TuiAltScreen } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { DialogRequest } from "./dialogs.ts";
import { messageText, oneLineFlat } from "./format.ts";
import { mdTheme } from "./pi-theme.ts";
import { attention, dim } from "./theme.ts";

export interface UserItem {
  kind: "user";
  component: UserMessageComponent;
}
export interface AssistantItem {
  kind: "assistant";
  component: AssistantMessageComponent;
  partial: Record<string, unknown> & { content: unknown[] };
  text: Map<number, string>;
  thinking: Map<number, string>;
}
export interface ToolItem {
  kind: "tool";
  component: ToolExecutionComponent;
}
export interface OtherItem {
  kind: "other";
  component: Text;
}
export type Item = UserItem | AssistantItem | ToolItem | OtherItem;

export interface SessionView {
  items: Item[];
  tools: Map<string, ToolItem>;
  dialog?: DialogRequest;
}

export function newView(): SessionView {
  return { items: [], tools: new Map() };
}

export function lastAssistant(view: SessionView): AssistantItem | undefined {
  for (let i = view.items.length - 1; i >= 0; i--) {
    const item = view.items[i];
    if (item.kind === "assistant") {
      return item;
    }
  }
  return undefined;
}

function assistantItem(message: Record<string, unknown>): AssistantItem {
  const partial = message as AssistantItem["partial"];
  return {
    kind: "assistant",
    component: new AssistantMessageComponent(partial as never, true, mdTheme, undefined, 1),
    partial,
    text: new Map(),
    thinking: new Map(),
  };
}

/** Fold one streaming delta into the assistant item's partial message. */
export function applyDelta(item: AssistantItem, delta: Record<string, unknown>): void {
  const idx = (delta.contentIndex as number) ?? 0;
  const content = item.partial.content;
  const type = delta.type as string;
  if (type === "text_delta") {
    let block = content[idx] as { type: string; text: string } | undefined;
    if (block?.type !== "text") {
      block = { type: "text", text: "" };
      content[idx] = block;
    }
    block.text = (item.text.get(idx) ?? "") + (delta.delta as string);
    item.text.set(idx, block.text);
  } else if (type === "thinking_delta") {
    let block = content[idx] as { type: string; thinking: string } | undefined;
    if (block?.type !== "thinking") {
      block = { type: "thinking", thinking: "" };
      content[idx] = block;
    }
    block.thinking = (item.thinking.get(idx) ?? "") + (delta.delta as string);
    item.thinking.set(idx, block.thinking);
  } else if (type === "text_end" || type === "thinking_end") {
    const block = content[idx] as { type: string; text?: string; thinking?: string } | undefined;
    const finalText = delta.content as string | undefined;
    if (block && typeof finalText === "string") {
      if (block.type === "text") {
        block.text = finalText;
        item.text.set(idx, finalText);
      } else if (block.type === "thinking") {
        block.thinking = finalText;
        item.thinking.set(idx, finalText);
      }
    }
  }
  // toolcall_* deltas are skipped: tools render from tool_execution_* events
}

export interface EventEnv {
  tui: TuiAltScreen;
  /** Working directory of the session, for relative tool paths. */
  cwd: string;
  /** Append an item to the view (and mount it if the view is on screen). */
  addItem(item: Item): void;
}

export interface EventEffects {
  /** One-line text of a finished user/assistant message (switcher description). */
  summary?: string;
  /** A user/assistant message finished: the session file was just written. */
  messageEnded?: boolean;
}

/** Apply one live pi event to a session view. */
export function applyEvent(view: SessionView, ev: Record<string, unknown>, env: EventEnv): EventEffects {
  const effects: EventEffects = {};
  switch (ev.type as string) {
    case "message_start": {
      const m = ev.message as { role?: string; content?: unknown };
      if (m?.role === "user") {
        env.addItem({ kind: "user", component: new UserMessageComponent(messageText(m), mdTheme, 1) });
      } else if (m?.role === "assistant") {
        env.addItem(assistantItem(m as Record<string, unknown>));
      }
      break;
    }
    case "message_update": {
      const item = lastAssistant(view);
      if (item) {
        applyDelta(item, ev.assistantMessageEvent as Record<string, unknown>);
        item.component.updateContent(item.partial as never, true);
        item.component.invalidate();
      }
      break;
    }
    case "message_end": {
      const m = ev.message as { role?: string; stopReason?: string; content?: unknown } | undefined;
      if (m?.role === "assistant" || m?.role === "user") {
        effects.messageEnded = true;
        if (messageText(m).trim()) {
          effects.summary = oneLineFlat(messageText(m), 80);
        }
      }
      if (m?.role === "assistant") {
        const item = lastAssistant(view);
        if (item) {
          item.partial = m as AssistantItem["partial"];
          item.component.updateContent(item.partial as never, false);
        } else {
          // attached mid-run: the completed message never streamed here
          env.addItem(assistantItem(m as Record<string, unknown>));
        }
        if (m.stopReason === "error") {
          const errText = messageText(m).trim() || "(provider error)";
          env.addItem({ kind: "other", component: new Text(attention(`error: ${errText}`), 1, 0) });
        }
      }
      break;
    }
    case "tool_execution_start": {
      const component = new ToolExecutionComponent(
        ev.toolName as string,
        ev.toolCallId as string,
        ev.args,
        undefined,
        undefined,
        env.tui,
        env.cwd,
      );
      component.markExecutionStarted();
      const item: ToolItem = { kind: "tool", component };
      env.addItem(item);
      view.tools.set(ev.toolCallId as string, item);
      break;
    }
    case "tool_execution_update": {
      const item = view.tools.get(ev.toolCallId as string);
      if (item) {
        item.component.updateArgs(ev.args);
        const partial = ev.partialResult as { content?: unknown } | undefined;
        if (partial) {
          item.component.updateResult({ ...partial, isError: false } as never, true);
        }
      }
      break;
    }
    case "tool_execution_end": {
      const item = view.tools.get(ev.toolCallId as string);
      if (item) {
        item.component.setArgsComplete();
        item.component.updateResult(ev.result as never, false);
      }
      break;
    }
  }
  return effects;
}

/** Build items from stored messages (history from the daemon, or a file). */
export function itemsFromMessages(messages: unknown[], tui: TuiAltScreen, cwd: string): Item[] {
  const items: Item[] = [];
  // toolCall blocks from assistant messages, matched to toolResults on replay
  const argsById = new Map<string, { name?: string; args: unknown }>();
  for (const raw of messages) {
    const m = raw as {
      role?: string;
      content?: unknown;
      toolName?: string;
      toolCallId?: string;
      isError?: boolean;
    };
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
        if (block?.type === "toolCall" && block.id) {
          argsById.set(block.id, { name: block.name, args: block.arguments ?? {} });
        }
      }
    }
    if (m.role === "user") {
      items.push({ kind: "user", component: new UserMessageComponent(messageText(m), mdTheme, 1) });
    } else if (m.role === "assistant") {
      items.push(assistantItem(m as Record<string, unknown>));
    } else if (m.role === "toolResult") {
      // Render tool results the way live does - a stub would hide the
      // interesting output (command results, file contents).
      if (m.toolName) {
        const call = m.toolCallId ? argsById.get(m.toolCallId) : undefined;
        const component = new ToolExecutionComponent(
          m.toolName,
          m.toolCallId ?? `replay-${items.length}`,
          call?.args ?? {},
          undefined,
          undefined,
          tui,
          cwd,
        );
        component.setArgsComplete();
        component.updateResult({ content: (m.content ?? []) as never, isError: m.isError ?? false }, false);
        items.push({ kind: "tool", component });
      } else {
        const text = messageText(m).trim();
        items.push({ kind: "other", component: new Text(dim(`(tool result) ${text.slice(0, 300)}`), 1, 0) });
      }
    }
  }
  return items;
}

/** The message entries of a session JSONL file, tolerating a torn last line. */
export function messagesFromFile(file: string): unknown[] {
  const messages: unknown[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as { type?: string; message?: unknown };
      if (entry.type === "message" && entry.message) {
        messages.push(entry.message);
      }
    } catch {
      // tolerate a torn trailing line
    }
  }
  return messages;
}

/** Replay a session file into items; an unreadable file yields a notice row. */
export function itemsFromFile(file: string, tui: TuiAltScreen, cwd: string): Item[] {
  try {
    return itemsFromMessages(messagesFromFile(file), tui, cwd);
  } catch {
    return [{ kind: "other", component: new Text(dim("(session file unreadable)"), 1, 0) }];
  }
}
