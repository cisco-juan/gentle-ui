import type { ClientMessage, ExtensionUiResponse, ServerMessage } from "@gentle-shell/protocol";

type Listener = (message: ServerMessage) => void;

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

export class BridgeClient {
	#socket: WebSocket | null = null;
	#listeners = new Set<Listener>();
	#pending = new Map<string, Pending>();
	#counter = 0;
	readonly #url: string;

	constructor(url: string) {
		this.#url = url;
	}

	get connected(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	connect(timeoutMs = 5_000): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(this.#url);
			const timer = setTimeout(() => {
				socket.close();
				reject(new Error(`bridge did not answer at ${this.#url}`));
			}, timeoutMs);

			socket.addEventListener("open", () => {
				clearTimeout(timer);
				this.#socket = socket;
				resolve();
			});
			socket.addEventListener("message", (event) => this.#handle(String(event.data)));
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error(`cannot reach the bridge at ${this.#url}`));
			});
			socket.addEventListener("close", () => {
				this.#socket = null;
				for (const [, pending] of this.#pending) pending.reject(new Error("bridge connection closed"));
				this.#pending.clear();
			});
		});
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	open(cwd: string): Promise<{ threadId: string; state: unknown }> {
		const id = this.#nextId();
		return this.#request<{ threadId: string; state: unknown }>({ kind: "open", id, cwd });
	}

	command<T = unknown>(threadId: string, command: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = this.#nextId();
		return this.#request<T>({ kind: "command", id, threadId, command, params });
	}

	answer(threadId: string, requestId: string, response: ExtensionUiResponse): void {
		this.#send({ kind: "ui-response", threadId, requestId, response });
	}

	close(): void {
		this.#socket?.close();
		this.#socket = null;
	}

	#nextId(): string {
		return `ui-${++this.#counter}`;
	}

	#send(message: ClientMessage): void {
		if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error("bridge is not connected");
		this.#socket.send(JSON.stringify(message));
	}

	#request<T>(message: ClientMessage & { id: string }): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(message.id, { resolve: (value) => resolve(value as T), reject });
			try {
				this.#send(message);
			} catch (error) {
				this.#pending.delete(message.id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	#handle(raw: string): void {
		let message: ServerMessage;
		try {
			message = JSON.parse(raw) as ServerMessage;
		} catch {
			return;
		}

		if (message.kind === "opened") {
			this.#settle(message.id, { threadId: message.threadId, state: message.state });
			return;
		}
		if (message.kind === "result") {
			if (message.ok) this.#settle(message.id, message.data);
			else this.#fail(message.id, new Error(message.error ?? `${message.command} failed`));
			return;
		}
		if (message.kind === "error" && message.id) {
			this.#fail(message.id, new Error(message.message));
			return;
		}

		for (const listener of this.#listeners) listener(message);
	}

	#settle(id: string, value: unknown): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		pending.resolve(value);
	}

	#fail(id: string, error: Error): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		pending.reject(error);
	}
}
