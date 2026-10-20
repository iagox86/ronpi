// Daemon smoke test: connect, read tabs, prompt a live child, wait for settle.
// Usage: node test/smoke-client.mjs
import net from "node:net";

const SOCK = process.env.RONPI_SOCK ?? `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/ronpi.sock`;
const sock = net.connect(SOCK);
let buf = "";
const messages = [];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

sock.on("data", (d) => {
	buf += d.toString("utf8");
	let idx;
	while ((idx = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, idx);
		buf = buf.slice(idx + 1);
		if (line) {
			messages.push(JSON.parse(line));
		}
	}
});

sock.on("error", (err) => {
	console.error("SMOKE FAIL (socket):", err.message);
	process.exit(1);
});

sock.on("connect", async () => {
	await wait(2000); // let tabs + history arrive
	const tabsMsg = messages.find((m) => m.type === "tabs");
	const tabs = tabsMsg?.tabs ?? [];
	console.error("TABS:", JSON.stringify(tabs.map((t) => ({ id: t.id, name: t.name, model: t.model, dead: t.dead }))));
	const tab = tabs.find((t) => !t.dead);
	if (!tab) {
		console.error("SMOKE FAIL: no live tab");
		process.exit(1);
	}
	const history = messages.find((m) => m.type === "history" && m.tab === tab.id);
	console.error(`HISTORY for tab ${tab.id}: ${history?.messages?.length ?? "?"} messages`);
	sock.write(`${JSON.stringify({ type: "prompt", tab: tab.id, message: "Reply with exactly: SMOKE-OK" })}\n`);

	const start = Date.now();
	const timer = setInterval(() => {
		const settled = messages.some(
			(m) => m.type === "event" && m.tab === tab.id && m.event.type === "agent_settled",
		);
		if (settled) {
			const assistant = messages
				.filter(
					(m) =>
						m.type === "event" &&
						m.tab === tab.id &&
						m.event.type === "message_end" &&
						m.event.message?.role === "assistant",
				)
				.map((m) =>
					(m.event.message.content ?? [])
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join(""),
				)
				.join(" || ");
			console.error("ASSISTANT TEXT:", assistant.slice(0, 300));
			const usage = messages.find(
				(m) => m.type === "event" && m.tab === tab.id && m.event.type === "message_update" && m.event.usage,
			)?.event?.usage;
			console.error("USAGE sample:", JSON.stringify(usage));
			console.error("SMOKE PASS");
			clearInterval(timer);
			process.exit(0);
		}
		if (Date.now() - start > 120_000) {
			console.error("SMOKE TIMEOUT");
			console.error("event types seen:", [...new Set(messages.map((m) => m.event?.type ?? m.type))].join(","));
			process.exit(1);
		}
	}, 500);
});
