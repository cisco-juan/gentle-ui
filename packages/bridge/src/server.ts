import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, PiCommand, ServerMessage, SessionSummary } from "@gentle-shell/protocol";
import { resolveCommand } from "./commands.ts";
import { gitDiff, gitStatus } from "./git.ts";
import { resolvePiEnvironment } from "./pi-environment.ts";
import {
	answerConsent,
	reviewAssess,
	reviewModeStatus,
	reviewStart,
	reviewStatus,
	type ReviewOptions,
} from "./review.ts";
import { listSessions } from "./sessions.ts";
import { ThreadHost, isDialogRequest } from "./thread-host.ts";
import { saveUpload } from "./uploads.ts";
import { listTree, readFileIn } from "./workspace.ts";

export interface BridgeServerOptions {
	readonly port?: number;
	readonly token?: string;
	readonly executable?: string;
	readonly env?: Readonly<Record<string, string>>;
	/** Session index behind the `sessions` request. Tests inject one instead of hitting the disk. */
	readonly sessions?: () => Promise<readonly SessionSummary[]>;
	/** Gentle Shell package root passed to `-e`; resolved from the machine when omitted. */
	readonly extension?: string;
	/** Directory the inspector reads files and git state from. Defaults to the bridge's cwd. */
	readonly workspace?: string;
	/**
	 * Native review options. The provider is an external binary, so this is how a test points the
	 * review family at a fake one; a packaged bridge leaves it undefined and discovery decides.
	 */
	readonly review?: ReviewOptions;
}

export interface BridgeServerHandle {
	readonly port: number;
	readonly token: string;
	close(): Promise<void>;
}

export async function startBridgeServer(options: BridgeServerOptions = {}): Promise<BridgeServerHandle> {
	const token = options.token ?? randomBytes(24).toString("hex");
	const workspace = options.workspace ?? process.cwd();
	const hosts = new Map<string, ThreadHost>();
	const sockets = new Set<WebSocket>();
	let uploadsHome: string | null = null;

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
		if (message.kind === "sessions") {
			const list = options.sessions ?? listSessions;
			try {
				send(socket, { kind: "sessions", id: message.id, items: await list() });
			} catch (error) {
				send(socket, { kind: "error", id: message.id, message: errorMessage(error) });
			}
			return;
		}

		// Workspace reads belong to the bridge, not to a thread: the inspector asks without a threadId.
		if (message.kind === "git" || message.kind === "fs") {
			try {
				await dispatchWorkspace(socket, message);
			} catch (error) {
				send(socket, { kind: "error", id: message.id, message: errorMessage(error) });
			}
			return;
		}

		// Native review belongs to the workspace, not to a thread: authority has no agent session.
		if (message.kind === "review") {
			try {
				await dispatchReview(socket, message);
			} catch (error) {
				send(socket, { kind: "error", id: message.id, message: errorMessage(error) });
			}
			return;
		}

		// Uploads belong to the agent home, not to a thread: the composer may attach a file before a
		// thread exists, and the path is what the next prompt carries.
		if (message.kind === "upload") {
			try {
				send(socket, {
					kind: "upload",
					id: message.id,
					data: await saveUpload(agentHome(), message.name, message.dataBase64),
				});
			} catch (error) {
				send(socket, { kind: "error", id: message.id, message: errorMessage(error) });
			}
			return;
		}

		if (message.kind === "open") {
			const host = new ThreadHost(message, {
				...(options.executable === undefined ? {} : { executable: options.executable }),
				...(options.env === undefined ? {} : { env: options.env }),
				...(options.extension === undefined ? {} : { extension: options.extension }),
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

	/**
	 * Directory attachments are written into: the agent home the child process runs with.
	 *
	 * Resolved once, lazily, from the same environment the launcher builds — an `env` override in the
	 * options wins, because that is the variable the child actually sees.
	 */
	function agentHome(): string {
		if (uploadsHome !== null) return uploadsHome;
		const configured = options.env?.["PI_CODING_AGENT_DIR"];
		if (configured !== undefined && configured.trim().length > 0) {
			uploadsHome = configured;
			return uploadsHome;
		}
		const resolved = resolvePiEnvironment({
			...(options.extension === undefined ? {} : { extension: options.extension }),
		}).env["PI_CODING_AGENT_DIR"];
		if (resolved === undefined || resolved.trim().length === 0) {
			throw new Error("the agent home is unknown; uploads need PI_CODING_AGENT_DIR");
		}
		uploadsHome = resolved;
		return uploadsHome;
	}

	/**
	 * One review answer per action, each already projected by the bridge.
	 *
	 * Nothing here synthesizes a token or retries a transition: the panel asks for status, and whatever
	 * that status offers is the only thing it can act on.
	 */
	async function dispatchReview(
		socket: WebSocket,
		message: Extract<ClientMessage, { kind: "review" }>,
	): Promise<void> {
		// The provider the panel talks to is the binary of the same package Pi is launched from, when the
		// bridge was told which package that is. An explicit binary always wins over this.
		const reviewOptions: ReviewOptions = {
			...(options.review ?? {}),
			...(options.extension === undefined ? {} : { packageRoot: options.extension }),
		};
		// The two actions with a payload are narrowed first, so the rest reads as one three-action family.
		if (message.action === "consent") {
			send(socket, {
				kind: "review",
				id: message.id,
				action: "consent",
				data: await answerConsent(message.invocation, { ...reviewOptions, cwd: workspace }),
			});
			return;
		}
		if (message.action === "start") {
			send(socket, {
				kind: "review",
				id: message.id,
				action: "start",
				data: await reviewStart(workspace, message.tokens, reviewOptions),
			});
			return;
		}
		if (message.action === "status") {
			send(socket, { kind: "review", id: message.id, action: "status", data: await reviewStatus(workspace, reviewOptions) });
			return;
		}
		if (message.action === "assess") {
			send(socket, { kind: "review", id: message.id, action: "assess", data: await reviewAssess(workspace, reviewOptions) });
			return;
		}
		send(socket, { kind: "review", id: message.id, action: "mode", data: await reviewModeStatus(workspace, reviewOptions) });
	}

	async function dispatchWorkspace(
		socket: WebSocket,
		message: Extract<ClientMessage, { kind: "git" | "fs" }>,
	): Promise<void> {
		if (message.kind === "git") {
			if (message.action === "status") {
				send(socket, { kind: "git", id: message.id, action: "status", data: await gitStatus(workspace) });
				return;
			}
			send(socket, {
				kind: "git",
				id: message.id,
				action: "diff",
				data: await gitDiff(workspace, requirePath(message.path)),
			});
			return;
		}

		if (message.action === "tree") {
			send(socket, {
				kind: "fs",
				id: message.id,
				action: "tree",
				data: await listTree(workspace, message.path ?? ""),
			});
			return;
		}
		send(socket, {
			kind: "fs",
			id: message.id,
			action: "read",
			data: await readFileIn(workspace, requirePath(message.path)),
		});
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

/** Incoming messages are untrusted JSON, so a path is checked before it reaches the filesystem. */
function requirePath(path: unknown): string {
	if (typeof path !== "string" || path.trim().length === 0) throw new Error("a path is required");
	return path;
}
