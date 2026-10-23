// Prints sample pi components in the active theme: `node theme-preview.ts [width]`.
import { renderDiff, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { AssistantMessage, UserMessage } from "./components.ts";
import { mdTheme } from "./pi-theme.ts";

const width = Number(process.argv[2] ?? 80);
const tui = { requestRender() {} } as never;
const show = (label: string, lines: string[]) => {
  console.log(`\n--- ${label} ---`);
  console.log(lines.join("\n"));
};

show("user", new UserMessage("Add a retry to the fetch helper", mdTheme, 1).render(width));

const mdMsg = { role: "assistant", content: [{ type: "text", text: "# Heading\n\nSome *emphasis*, **bold**, `inline code` and a [link](https://example.com).\n\n- bullet one\n- bullet two\n\n> a quote\n\n```ts\nconst n: number = 42; // comment\nfunction go(s: string) { return s + 1; }\n```\n" }], stopReason: "stop" };
show("markdown", new AssistantMessage(mdMsg as never, true, mdTheme, undefined, 1).render(width));

const msg = { role: "assistant", content: [{ type: "thinking", thinking: "Considering the options..." }, { type: "text", text: "Done." }], stopReason: "stop" };
show("assistant (thinking shown)", new AssistantMessage(msg as never, false, mdTheme, undefined, 1).render(width));

show("diff", renderDiff("  1 const a = 1;\n- 2 const b = 2;\n+ 2 const b = 3;\n  3 const c = 4;").split("\n"));

const tool = (name: string, args: unknown, text: string, isError = false) => {
  const c = new ToolExecutionComponent(name, `id-${name}`, args, undefined, undefined, tui, process.cwd());
  c.updateResult({ content: [{ type: "text", text }], isError }, false);
  return c;
};
show("tool: bash ok", tool("bash", { command: "ls" }, "a.ts\nb.ts\nc.ts").render(width));
show("tool: bash error", tool("bash", { command: "false" }, "boom\nexit 1", true).render(width));
show("tool: read", tool("read", { path: "a.ts" }, "line1\nline2").render(width));
