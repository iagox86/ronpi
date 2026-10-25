// The transcript model: one renderer for both live event streams and replays
// of session files, so the two views cannot drift apart. Items are pi's own
// message/tool components; this module builds and updates them.
import * as fs from "node:fs";
import { Text, type TuiAltScreen } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { AssistantMessage, CompactionRow, UserMessage } from "./components.ts";
import { type ActivityState, reduceActivity } from "./activity.ts";
import { binaryReadDisplay } from "./binary-view.ts";
import { prettyError } from "./error-format.ts";
import { toolDefinitionFor } from "./tool-defs.ts";
import { type ToolCall, ToolRun } from "./tool-run.ts";
import type { DialogRequest } from "./dialogs.ts";
import { messageText, oneLineFlat } from "./format.ts";
import { mdTheme } from "./pi-theme.ts";
import { attention, dim } from "./theme.ts";

interface ItemBase {
  /** Shown faint: the model no longer has it (before a compaction). */
  dimmed?: boolean;
}
export interface UserItem extends ItemBase {
  kind: "user";
  component: UserMessage;
}
export interface CompactionItem extends ItemBase {
  kind: "compaction";
  component: CompactionRow;
}
export interface AssistantItem extends ItemBase {
  kind: "assistant";
  component: AssistantMessage;
  partial: Record<string, unknown> & { content: unknown[] };
  text: Map<number, string>;
  thinking: Map<number, string>;
}
export interface ToolItem extends ItemBase {
  kind: "tools";
  component: ToolRun;
}
export interface OtherItem extends ItemBase {
  kind: "other";
  component: Text;
}
export type Item = UserItem | AssistantItem | ToolItem | OtherItem | CompactionItem;

/** pi's own compaction row (collapsed summary, expandable). */
/** Why a turn that ended on the output-token limit shows nothing: the model spent it all (usually thinking). */
export function lengthNotice(m: { usage?: { output?: number; reasoning?: number } }): string {
  const out = m.usage?.output;
  const spent = out ? ` (${out.toLocaleString("en-US")} output tokens${m.usage?.reasoning ? `, ${m.usage.reasoning.toLocaleString("en-US")} of them thinking` : ""})` : "";
  return `Stopped: hit the model's output limit${spent} before finishing. Raise maxTokens for this model in ~/.pi/agent/models.json.`;
}

export function compactionItem(summary: string, tokensBefore: number, timestamp: number): CompactionItem {
  const message = { role: "compactionSummary" as const, summary, tokensBefore, timestamp };
  return { kind: "compaction", component: new CompactionRow(message, mdTheme, 1) };
}

export interface SessionView extends ActivityState {
  items: Item[];
  /** Tool calls of this view by toolCallId, across all runs. */
  tools: Map<string, ToolCall>;
  dialog?: DialogRequest;
  /** Deny reason typed inline on a select; answers the input dialog the package chains next. */
  pendingReason?: { text: string; at: number };
  /** Prompts shown on send, before pi echoed them back as user messages. */
  echoes: Array<{ text: string; item: UserItem }>;
  /** The "working" spinner was started by a sent prompt, not by anything pi reported (yet). */
  echoActivity?: boolean;
}

export function newView(): SessionView {
  return { items: [], tools: new Map(), queue: [], echoes: [] };
}

/** Show a just-sent prompt at once; pi's own user message later adopts it instead of adding a second. */
export function echoUser(view: SessionView, text: string, env: Pick<EventEnv, "addItem">): void {
  const item: UserItem = { kind: "user", component: new UserMessage(text, mdTheme, 1) };
  view.echoes.push({ text: text.trim(), item });
  env.addItem(item);
  if (!view.activity) {
    view.activity = { label: "working", since: Date.now() };
    view.echoActivity = true;
  }
}

/** The prompt never went through: take its echo back out. Returns false if there was none. */
export function dropEcho(view: SessionView, text: string): boolean {
  const i = view.echoes.findIndex((e) => e.text === text.trim());
  if (i === -1) {
    return false;
  }
  const [echo] = view.echoes.splice(i, 1);
  view.items = view.items.filter((it) => it !== echo.item);
  // only the spinner this prompt started: a compaction or run already going keeps its own
  if (view.echoes.length === 0 && view.echoActivity) {
    view.activity = undefined;
  }
  return true;
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
    component: new AssistantMessage(partial as never, true, mdTheme, undefined, 1),
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

/** Add a call to the trailing tool run, or start a new run. */
function appendCall(view: SessionView, env: EventEnv, call: ToolCall): void {
  const last = view.items[view.items.length - 1];
  if (last?.kind === "tools") {
    last.component.calls.push(call);
    return;
  }
  const run = new ToolRun();
  run.calls.push(call);
  env.addItem({ kind: "tools", component: run });
}

/** Apply one live pi event to a session view. */
export function applyEvent(view: SessionView, ev: Record<string, unknown>, env: EventEnv): EventEffects {
  const effects: EventEffects = {};
  reduceActivity(view, ev, Date.now());
  view.echoActivity = false; // whatever the spinner shows now is pi's
  switch (ev.type as string) {
    case "message_start": {
      const m = ev.message as { role?: string; content?: unknown };
      if (m?.role === "user") {
        const text = messageText(m).trim();
        const echoed = view.echoes.findIndex((e) => e.text === text);
        if (echoed !== -1) {
          view.echoes.splice(echoed, 1);
        } else {
          env.addItem({ kind: "user", component: new UserMessage(messageText(m), mdTheme, 1) });
        }
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
    case "compaction_end": {
      const r = ev.result as { summary?: string; tokensBefore?: number } | undefined;
      if (r?.summary) {
        env.addItem(compactionItem(r.summary, r.tokensBefore ?? 0, Date.now()));
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
        // pi's component draws errors itself, except on messages with tool calls
        const hasToolCalls = Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((c) => c?.type === "toolCall");
        if (m.stopReason === "error" && hasToolCalls) {
          const errText = prettyError((m as { errorMessage?: string }).errorMessage || "provider error");
          env.addItem({ kind: "other", component: new Text(attention(`Error: ${errText}`), 1, 0) });
        }
        if (m.stopReason === "length") {
          env.addItem({ kind: "other", component: new Text(attention(lengthNotice(m as { usage?: { output?: number; reasoning?: number } })), 1, 0) });
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
        toolDefinitionFor(ev.toolName as string, env.cwd) as never,
        env.tui,
        env.cwd,
      );
      component.markExecutionStarted();
      const call: ToolCall = { name: ev.toolName as string, args: ev.args, component, failed: false };
      appendCall(view, env, call);
      view.tools.set(ev.toolCallId as string, call);
      break;
    }
    case "tool_execution_update": {
      const item = view.tools.get(ev.toolCallId as string);
      if (item) {
        item.args = ev.args;
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
        // the event carries isError beside the result; pi's block colors itself red from the result's own flag
        const result = { ...(ev.result as { content?: unknown }), isError: Boolean(ev.isError) };
        item.component.updateResult((binaryReadDisplay(item.name, item.args, result, env.cwd) ?? result) as never, false);
        item.failed = Boolean(ev.isError);
        item.done = true;
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
    const startLen = items.length;
    const m = raw as {
      outOfContext?: boolean;
      summary?: string;
      tokensBefore?: number;
      timestamp?: number;
      role?: string;
      content?: unknown;
      toolName?: string;
      toolCallId?: string;
      isError?: boolean;
      details?: unknown;
    };
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
        if (block?.type === "toolCall" && block.id) {
          argsById.set(block.id, { name: block.name, args: block.arguments ?? {} });
        }
      }
    }
    if (m.role === "compactionSummary") {
      items.push(compactionItem(m.summary ?? "", m.tokensBefore ?? 0, m.timestamp ?? Date.now()));
    } else if (m.role === "user") {
      items.push({ kind: "user", component: new UserMessage(messageText(m), mdTheme, 1) });
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
          toolDefinitionFor(m.toolName, cwd) as never,
          tui,
          cwd,
        );
        component.setArgsComplete();
        const result = { content: (m.content ?? []) as never, details: m.details, isError: m.isError ?? false };
        component.updateResult((binaryReadDisplay(m.toolName, call?.args, result, cwd) ?? result) as never, false);
        const toolCall: ToolCall = { name: m.toolName, args: call?.args, component, failed: m.isError ?? false, done: true };
        const last = items[items.length - 1];
        if (last?.kind === "tools") {
          last.component.calls.push(toolCall);
        } else {
          const run = new ToolRun();
          run.calls.push(toolCall);
          items.push({ kind: "tools", component: run });
        }
      } else {
        const text = messageText(m).trim();
        items.push({ kind: "other", component: new Text(dim(`(tool result) ${text.slice(0, 300)}`), 1, 0) });
      }
    }
    if (m.outOfContext) {
      for (let i = startLen; i < items.length; i++) {
        (items[i] as Item).dimmed = true;
      }
    }
  }
  return items;
}

/**
 * The conversation of a session JSONL file, tolerating a torn last line. Pi keeps
 * every entry after a compaction, but the model only has the summary plus the
 * entries from `firstKeptEntryId` on: a compaction becomes a summary marker where it
 * happened, and the messages the summary replaces are flagged `outOfContext`.
 */
export function messagesFromFile(file: string): unknown[] {
  const entries: Array<{ id?: string; message: Record<string, unknown> }> = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) {
      continue;
    }
    try {
      const e = JSON.parse(line) as {
        type?: string;
        id?: string;
        message?: Record<string, unknown>;
        summary?: string;
        firstKeptEntryId?: string;
        tokensBefore?: number;
        timestamp?: string;
      };
      if (e.type === "message" && e.message) {
        entries.push({ id: e.id, message: e.message });
      } else if (e.type === "compaction" && typeof e.summary === "string") {
        const marker = {
          role: "compactionSummary",
          summary: e.summary,
          tokensBefore: e.tokensBefore ?? 0,
          timestamp: Date.parse(e.timestamp ?? "") || Date.now(),
        };
        const keptAt = e.firstKeptEntryId ? entries.findIndex((x) => x.id === e.firstKeptEntryId) : -1;
        const summarized = keptAt === -1 ? entries.length : keptAt;
        for (let i = 0; i < summarized; i++) {
          entries[i] = { ...entries[i]!, message: { ...entries[i]!.message, outOfContext: true } };
        }
        // where it happened, so it is the thing seen at the bottom right after compacting
        entries.push({ message: marker });
      }
    } catch {
      // tolerate a torn trailing line
    }
  }
  return entries.map((x) => x.message);
}

/** Replay a session file into items; an unreadable file yields a notice row. */
export function itemsFromFile(file: string, tui: TuiAltScreen, cwd: string): Item[] {
  try {
    return itemsFromMessages(messagesFromFile(file), tui, cwd);
  } catch {
    return [{ kind: "other", component: new Text(dim("(session file unreadable)"), 1, 0) }];
  }
}
