import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, PiCommand, ServerMessage } from "@gentle-shell/protocol";
import { resolveCommand } from "./commands.ts";
import { ThreadHost, isDialogRequest } from "./thread-host.ts";

export interface BridgeServerOptions {
	readonly port?: number;
	readonly token?: string;
	readonly executable?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export interface BridgeServerHandle {
	readonly port: number;
	readonly token: string;
	close(): Promise<void>;
}

export async function startBridgeServer(options: BridgeServerOptions = {}): Promise<BridgeServerHandle> {
	const token = options.token ?? randomBytes(24).toString("hex");
	const hosts = new Map<string, ThreadHost>();
	const sockets = new Set<WebSocket>();

	const httpServer = createServer((_request, response) => {
		response.writeHead(426, { "content-type": "text/plain" });
		response.end("gentle-shell bridge speaks WebSocket only\n");
	});

	const wsServer = new WebSocketServer({ noServer: true });

	httpServer.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.searchParams.get("token") !== token) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		wsServer.handleUpgrade(request, socket, head, (client) => wsServer.emit("connection", client, request));
	});

	function send(socket: WebSocket, message: ServerMessage): void {
		if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
	}

	function broadcast(message: ServerMessage): void {
		const payload = JSON.stringify(message);
		for (const socket of sockets) {
			if (socket.readyState === socket.OPEN) socket.send(payload);
		}
	}

	function attach(host: ThreadHost): void {
		hosts.set(host.id, host);
		host.pi.on("record", (record: Record<string, unknown>) => {
			broadcast({ kind: "record", threadId: host.id, record: record as { type: string } });
		});
		host.pi.on("ui-request", (request: Record<string, unknown>) => {
			if (!isDialogRequest(request as never)) {
				broadcast({ kind: "record", threadId: host.id, record: request as { type: string } });
				return;
			}
			broadcast({ kind: "ui-request", threadId: host.id, request: request as never });
		});
		host.pi.on("log", (line: string) => broadcast({ kind: "log", threadId: host.id, line }));
		host.pi.on("exit", (info: { code: number | null }) => {
			hosts.delete(host.id);
			broadcast({ kind: "exited", threadId: host.id, code: info.code });
		});
	}

	async function dispatch(socket: WebSocket, message: ClientMessage): Promise<void> {
		if (message.kind === "open") {
			const host = new ThreadHost(message, {
				...(options.executable === undefined ? {} : { executable: options.executable }),
				...(options.env === undefined ? {} : { env: options.env }),
			});
			attach(host);
			try {
				const state = await host.ready(message);
				send(socket, { kind: "opened", id: message.id, threadId: host.id, state });
			} catch (error) {
				broadcast({ kind: "error", id: message.id, message: errorMessage(error) });
				await host.close();
			}
			return;
		}

		const host = message.kind === "close" ? hosts.get(message.threadId) : hosts.get(message.threadId);
		if (!host) {
			if (message.kind === "command") {
				send(socket, { kind: "result", id: message.id, threadId: message.threadId, command: message.command, ok: false, error: `unknown thread: ${message.threadId}` });
			} else {
				broadcast({ kind: "error", message: `unknown thread: ${message.threadId}` });
			}
			return;
		}

		if (message.kind === "close") {
			hosts.delete(host.id);
			await host.close();
			return;
		}

		if (message.kind === "ui-response") {
			await host.answer(message.requestId, message.response);
			return;
		}

		let command: PiCommand;
		try {
			command = resolveCommand(message.command);
		} catch (error) {
			send(socket, { kind: "result", id: message.id, threadId: host.id, command: message.command, ok: false, error: errorMessage(error) });
			return;
		}

		try {
			const data = await host.pi.send(command, message.params ?? {});
			send(socket, { kind: "result", id: message.id, threadId: host.id, command, ok: true, data });
		} catch (error) {
			send(socket, { kind: "result", id: message.id, threadId: host.id, command, ok: false, error: errorMessage(error) });
		}
	}

	wsServer.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => sockets.delete(socket));
		socket.on("message", (raw) => {
			let message: ClientMessage;
			try {
				message = JSON.parse(raw.toString()) as ClientMessage;
			} catch {
				send(socket, { kind: "error", message: "malformed JSON message" });
				return;
			}
			void dispatch(socket, message);
		});
	});

	await new Promise<void>((resolve) => httpServer.listen(options.port ?? 0, "127.0.0.1", resolve));
	const address = httpServer.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		port,
		token,
		async close() {
			for (const host of [...hosts.values()]) await host.close();
			hosts.clear();
			for (const socket of [...sockets]) socket.close();
			sockets.clear();
			await new Promise<void>((resolve) => wsServer.close(() => resolve()));
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
