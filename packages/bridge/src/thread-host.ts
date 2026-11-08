import { randomUUID } from "node:crypto";
import type { ExtensionUiRequest, ExtensionUiResponse, OpenThreadRequest } from "@gentle-shell/protocol";
import { PiProcess } from "./pi-process.ts";

interface ThreadHostOptions {
	readonly executable?: string;
	readonly env?: Readonly<Record<string, string>>;
}

/**
 * One conversation: a Pi child process plus its identity.
 *
 * The bridge keeps the child alive across requests so a thread keeps its context, model choice and
 * queue. Closing the host is the only way a thread releases its process.
 */
export class ThreadHost {
	readonly id = randomUUID();
	readonly pi: PiProcess;
	readonly cwd: string;
	/** Last `get_state` payload, kept so a reconnecting UI can render without an extra round trip. */
	state: unknown = null;

	constructor(request: OpenThreadRequest, options: ThreadHostOptions = {}) {
		this.cwd = request.cwd ?? process.cwd();
		this.pi = new PiProcess({
			cwd: this.cwd,
			...(options.executable === undefined ? {} : { executable: options.executable }),
			...(options.env === undefined ? {} : { env: options.env }),
		});
		this.pi.start();
	}

	/** Confirm the child answers, optionally resume a session, and cache the initial state. */
	async ready(request: OpenThreadRequest): Promise<unknown> {
		let state = await this.pi.send("get_state");
		if (request.sessionPath !== undefined) {
			await this.pi.send("switch_session", { sessionPath: request.sessionPath });
			// The cached state has to describe the resumed session, not the fresh one it replaced.
			state = await this.pi.send("get_state");
		}
		if (request.provider !== undefined && request.model !== undefined) {
			await this.pi.send("set_model", { provider: request.provider, model: request.model });
			state = await this.pi.send("get_state");
		}
		this.state = state;
		return state;
	}

	async answer(requestId: string, response: ExtensionUiResponse): Promise<void> {
		await this.pi.sendRaw({ type: "extension_ui_response", id: requestId, ...response });
	}

	async close(): Promise<void> {
		await this.pi.stop();
	}
}

export function isDialogRequest(request: ExtensionUiRequest): boolean {
	return request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor";
}
