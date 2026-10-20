// Wire protocol between the daemon and controllers: JSONL over a unix socket.
// Framing is LF-only (never readline: U+2028/U+2029 are legal inside JSON strings).

export interface TabMeta {
	id: number;
	cwd: string;
	name: string;
	model: string;
	sessionId?: string;
	sessionFile?: string;
	messageCount: number;
	streaming: boolean;
	dead: boolean;
	pendingDialog: boolean;
}

export interface TabSnapshot {
	tabs: TabMeta[];
}

// controller -> daemon
export type ClientCommand =
	| { type: "prompt"; tab: number; message: string }
	| { type: "abort"; tab: number }
	| { type: "spawn"; cwd?: string }
	| { type: "ui_response"; tab: number; response: Record<string, unknown> };

// daemon -> controller
export type DaemonMessage =
	| { type: "tabs"; tabs: TabMeta[] }
	| { type: "event"; tab: number; event: Record<string, unknown> }
	| { type: "history"; tab: number; messages: unknown[] }
	| { type: "ui_request"; tab: number; request: Record<string, unknown> }
	| { type: "exited"; tab: number };

export function encodeLine(obj: unknown): string {
	return JSON.stringify(obj) + "\n";
}

export class LineSplitter {
	private buf = "";

	push(chunk: string): string[] {
		this.buf += chunk;
		const lines: string[] = [];
		let idx: number;
		while ((idx = this.buf.indexOf("\n")) !== -1) {
			let line = this.buf.slice(0, idx);
			if (line.endsWith("\r")) {
				line = line.slice(0, -1);
			}
			this.buf = this.buf.slice(idx + 1);
			if (line.length > 0) {
				lines.push(line);
			}
		}
		return lines;
	}
}
