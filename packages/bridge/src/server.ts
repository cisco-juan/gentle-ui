import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type {
	ClientMessage,
	McpResult,
	PackagesResult,
	PermissionsResult,
	PiCommand,
	ProfilesResult,
	ServerMessage,
	SessionSummary,
	SettingsResult,
} from "@gentle-shell/protocol";
import { resolveCommand } from "./commands.ts";
import { gitDiff, gitStatus } from "./git.ts";
import { agentDetail, listAgents, type AgentsOptions } from "./agents.ts";
import { readHistoryPage } from "./history.ts";
import { memoryContext, memoryProjects, memorySearch, type MemoryOptions } from "./memory.ts";
import { mcpApply, mcpList, mcpPreview, type McpOptions } from "./mcp.ts";
import { packagesApply, packagesList, packagesPreview, type PackagesOptions } from "./packages.ts";
import { permissionsSetDefault, permissionsStatus, type PermissionsOptions } from "./permissions.ts";
import {
	profilesActivate,
	profilesCreate,
	profilesDelete,
	profilesList,
	profilesRename,
	profilesSave,
	type ProfilesOptions,
} from "./profiles.ts";
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
import { settingsRead, type SettingsOptions } from "./settings.ts";
import { settingsWriteApply, settingsWritePreview, type SettingsWriteOptions } from "./settings-write.ts";
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
	/** Engram options, for the same reason: a test points the memory family at a fake MCP server. */
	readonly memory?: MemoryOptions;
	/** Where profiles live and which gentle-pi reads them; a test points this at a scratch config home. */
	readonly profiles?: ProfilesOptions;
	/** Where gentle-pi keeps the default permission mode; a test points this at a scratch config home. */
	readonly permissions?: PermissionsOptions;
	/** The agent's own configuration files; a test points this at a scratch agent home. */
	readonly settings?: SettingsOptions;
	/** The keys of that same file the sheet may set, and where their backups go. */
	readonly settingsWrite?: SettingsWriteOptions;
	/** The agent's packages list, and where its backups go; a test points this at a scratch pair of homes. */
	readonly packages?: PackagesOptions;
	/** The agent's MCP servers, in the same homes and behind the same confirmation. */
	readonly mcp?: McpOptions;
	/** Where the agent publishes subagent activity; a test points this at a scratch agent home. */
	readonly agents?: AgentsOptions;
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
			// Pi's process already re-emits every request as a `record`, so only a dialog needs this second
			// channel; sending the rest again showed each notify and status update twice.
			if (!isDialogRequest(request as never)) return;
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

		// A transcript page is read from the session file the rail lists, not from Pi: `get_messages` only
		// ever answers with the tail, which is why a long thread used to reopen as three rows.
		if (message.kind === "history") {
			try {
				send(socket, {
					kind: "history",
					id: message.id,
					data: await readHistoryPage(message.sessionPath, {
						...(message.before === undefined ? {} : { before: message.before }),
						...(message.limit === undefined ? {} : { limit: message.limit }),
					}),
				});
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

		// Memory belongs to the workspace too: Engram derives its project from the workspace directory.
		if (message.kind === "memory") {
			try {
				await dispatchMemory(socket, message);
			} catch (error) {
				send(socket, { kind: "error", id: message.id, message: errorMessage(error) });
			}
			return;
		}

		// The permission default belongs to the same configuration. What it may be set to is decided in
		// permissions.ts, on this side of the wire: an elevated mode is refused whoever asks.
		if (message.kind === "permissions") {
			try {
				await dispatchPermissions(socket, message);
			} catch (error) {
				send(socket, { kind: "error", id: message.id, message: errorMessage(error) });
			}
			return;
		}

		// Profiles belong to the user's Gentle Shell configuration, not to a thread; the workspace only
		// matters for the repository pin that can override the default for new threads here.
		if (message.kind === "profiles") {
			try {
				await dispatchProfiles(socket, message);
			} catch (error) {
				send(socket, { kind: "error", id: message.id, message: errorMessage(error) });
			}
			return;
		}

		// The agent's own configuration belongs to the same home the bridge launches Pi with, not to a
		// thread. One family on the wire, two modules behind it: `read` answers the whole view from
		// `settings.ts`, while `preview` and `apply` edit the bounded key set in `settings-write.ts`, with
		// the same digest-bound plan the `packages` family uses on the same file.
		if (message.kind === "settings") {
			try {
				await dispatchSettings(socket, message);
			} catch (error) {
				send(socket, { kind: "error", id: message.id, message: errorMessage(error) });
			}
			return;
		}

		// The packages list is the first family that writes. It writes to that same home, and only with
		// the digest of the plan the confirmation showed: preview and apply are two separate requests.
		if (message.kind === "packages") {
			try {
				await dispatchPackages(socket, message);
			} catch (error) {
				send(socket, { kind: "error", id: message.id, message: errorMessage(error) });
			}
			return;
		}

		// The MCP servers are the family that holds credentials. Same two requests, same digest, and every
		// secret stays on this side of the wire: what `mcp.ts` answers is already redacted.
		if (message.kind === "mcp") {
			try {
				await dispatchMcp(socket, message);
			} catch (error) {
				send(socket, { kind: "error", id: message.id, message: errorMessage(error) });
			}
			return;
		}

		// Subagent activity belongs to the thread whose session file is open. The agent publishes it under
		// its own home, one file per Pi incarnation, so the session id in the file name is what finds the
		// right one; the answer is read from disk and needs no threadId.
		if (message.kind === "agents") {
			try {
				await dispatchAgents(socket, message);
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

		// Everything above is workspace-scoped. Reaching here with an unknown kind means an older client
		// asking for something this bridge does not have: say so instead of blaming a missing thread.
		const loose = message as { kind?: unknown; id?: unknown };
		if (loose.kind !== "close" && loose.kind !== "command" && loose.kind !== "ui-response") {
			const text = `unsupported message kind: ${String(loose.kind)}`;
			if (typeof loose.id === "string") send(socket, { kind: "error", id: loose.id, message: text });
			else broadcast({ kind: "error", message: text });
			return;
		}

		const host = hosts.get(message.threadId);
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
			// A prompt can be an extension command that asks the person something; Pi answers it only once
			// they have, so it is the one command that must not be timed out.
			const data = await host.pi.send(command, message.params ?? {}, command === "prompt" ? null : undefined);
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

	/**
	 * One memory answer per action, each already projected by the bridge.
	 *
	 * An unavailable Engram is a typed answer, not an error: the panel has to say *why* it is empty,
	 * and the `error` shape is reserved for a request this bridge cannot serve at all.
	 */
	async function dispatchMemory(
		socket: WebSocket,
		message: Extract<ClientMessage, { kind: "memory" }>,
	): Promise<void> {
		const memoryOptions = options.memory ?? {};
		if (message.action === "search") {
			// A search with no query is a caller mistake, so it is a real failure rather than an
			// unavailable memory that the panel would have to explain.
			const query = typeof message.query === "string" ? message.query.trim() : "";
			if (query.length === 0) throw new Error("a memory search needs a query");
			send(socket, {
				kind: "memory",
				id: message.id,
				action: "search",
				data: await memorySearch(workspace, query, message.limit, memoryOptions),
			});
			return;
		}
		if (message.action === "projects") {
			send(socket, {
				kind: "memory",
				id: message.id,
				action: "projects",
				data: await memoryProjects(workspace, memoryOptions),
			});
			return;
		}
		send(socket, {
			kind: "memory",
			id: message.id,
			action: "context",
			data: await memoryContext(workspace, memoryOptions),
		});
	}

	async function dispatchPermissions(
		socket: WebSocket,
		message: Extract<ClientMessage, { kind: "permissions" }>,
	): Promise<void> {
		const permissionOptions = options.permissions ?? {};
		const reply = (answer: PermissionsResult): void => send(socket, { kind: "permissions", id: message.id, ...answer });

		switch (message.action) {
			case "status":
				return reply({ action: "status", data: await permissionsStatus(permissionOptions) });
			case "default":
				return reply({ action: "default", data: await permissionsSetDefault(message.mode, permissionOptions) });
			default:
				throw new Error(`unsupported permissions action: ${String((message as { action?: unknown }).action)}`);
		}
	}

	async function dispatchProfiles(
		socket: WebSocket,
		message: Extract<ClientMessage, { kind: "profiles" }>,
	): Promise<void> {
		const profileOptions = options.profiles ?? {};
		const reply = (answer: ProfilesResult): void => send(socket, { kind: "profiles", id: message.id, ...answer });

		switch (message.action) {
			case "list":
				return reply({ action: "list", data: await profilesList(workspace, profileOptions) });
			case "save":
				return reply({
					action: "save",
					data: await profilesSave(workspace, message.name, message.routes, message.mode, profileOptions),
				});
			case "create":
				return reply({
					action: "create",
					data: await profilesCreate(workspace, message.name, message.from, profileOptions),
				});
			case "rename":
				return reply({ action: "rename", data: await profilesRename(workspace, message.name, message.to, profileOptions) });
			case "delete":
				return reply({ action: "delete", data: await profilesDelete(workspace, message.name, profileOptions) });
			case "activate":
				return reply({ action: "activate", data: await profilesActivate(workspace, message.name, profileOptions) });
			default:
				// A client that sends an action this bridge does not know must hear so, not wait forever.
				throw new Error(`unsupported profiles action: ${String((message as { action?: unknown }).action)}`);
		}
	}

	/**
	 * The agent's configuration: a read of the whole view, and a write of one of its keys.
	 *
	 * `read` is `settings.ts`'s — one answer, already projected and already redacted here, so no path,
	 * header or token crosses the wire because a client asked for a field by name. `preview` and `apply`
	 * are `settings-write.ts`'s: the writable keys, the value rules and the refusal messages are decided
	 * there, on this side of the wire, and a write needs the digest of the plan the preview returned.
	 */
	async function dispatchSettings(
		socket: WebSocket,
		message: Extract<ClientMessage, { kind: "settings" }>,
	): Promise<void> {
		const settingsOptions = options.settings ?? {};
		const writeOptions = options.settingsWrite ?? {};
		const reply = (answer: SettingsResult): void => send(socket, { kind: "settings", id: message.id, ...answer });

		switch (message.action) {
			case "read":
				return reply({ action: "read", data: await settingsRead(workspace, settingsOptions) });
			case "preview":
				return reply({
					action: "preview",
					data: await settingsWritePreview(workspace, { key: message.key, value: message.value }, writeOptions),
				});
			case "apply":
				return reply({
					action: "apply",
					data: await settingsWriteApply(
						workspace,
						{ key: message.key, value: message.value },
						message.digest,
						writeOptions,
					),
				});
			default:
				throw new Error(`unsupported settings action: ${String((message as { action?: unknown }).action)}`);
		}
	}

	/**
	 * The packages list: one read, and a write in two requests.
	 *
	 * `preview` writes nothing and answers with the plan and the digest the confirmation shows; `apply`
	 * repeats the operation and the source the user confirmed, plus that digest. What may be written is
	 * decided in `packages.ts`, on this side of the wire, exactly as the permission default is.
	 */
	async function dispatchPackages(
		socket: WebSocket,
		message: Extract<ClientMessage, { kind: "packages" }>,
	): Promise<void> {
		const packagesOptions = options.packages ?? {};
		const reply = (answer: PackagesResult): void => send(socket, { kind: "packages", id: message.id, ...answer });

		switch (message.action) {
			case "list":
				return reply({ action: "list", data: await packagesList(workspace, packagesOptions) });
			case "preview":
				return reply({
					action: "preview",
					data: await packagesPreview(workspace, message.operation, message.source, packagesOptions),
				});
			case "apply":
				return reply({
					action: "apply",
					data: await packagesApply(workspace, message.operation, message.source, message.digest, packagesOptions),
				});
			default:
				throw new Error(`unsupported packages action: ${String((message as { action?: unknown }).action)}`);
		}
	}

	/**
	 * The MCP servers: one read, and a write in two requests, exactly as the packages list.
	 *
	 * `preview` writes nothing and answers with the plan and the digest the confirmation shows; `apply`
	 * repeats the operation, the name and the fields the user confirmed, plus that digest. Everything
	 * that decides what a server may be is `mcp.ts`'s, on this side of the wire, and so is the redaction
	 * of every value that could hold a credential.
	 */
	async function dispatchMcp(socket: WebSocket, message: Extract<ClientMessage, { kind: "mcp" }>): Promise<void> {
		const mcpOptions = options.mcp ?? {};
		const reply = (answer: McpResult): void => send(socket, { kind: "mcp", id: message.id, ...answer });

		switch (message.action) {
			case "list":
				return reply({ action: "list", data: await mcpList(workspace, mcpOptions) });
			case "preview":
				return reply({
					action: "preview",
					data: await mcpPreview(
						workspace,
						{ operation: message.operation, name: message.name, ...(message.server === undefined ? {} : { server: message.server }) },
						mcpOptions,
					),
				});
			case "apply":
				return reply({
					action: "apply",
					data: await mcpApply(
						workspace,
						{ operation: message.operation, name: message.name, ...(message.server === undefined ? {} : { server: message.server }) },
						message.digest,
						mcpOptions,
					),
				});
			default:
				throw new Error(`unsupported mcp action: ${String((message as { action?: unknown }).action)}`);
		}
	}

	/**
	 * Subagent activity of the open thread, projected by the bridge from gentle-pi's presence files.
	 *
	 * The files sit under the agent home the child process runs with; an explicit option wins, so a test
	 * can point the family at a scratch directory.
	 */
	async function dispatchAgents(
		socket: WebSocket,
		message: Extract<ClientMessage, { kind: "agents" }>,
	): Promise<void> {
		const agentOptions: AgentsOptions = { agentHome: options.agents?.agentHome ?? agentHome() };
		const sessionPath =
			typeof message.sessionPath === "string" && message.sessionPath.trim().length > 0 ? message.sessionPath : undefined;
		const scope = sessionPath === undefined ? agentOptions : { ...agentOptions, sessionPath };

		if (message.action === "detail") {
			send(socket, { kind: "agents", id: message.id, data: await agentDetail({ ...scope, taskId: message.taskId }) });
			return;
		}
		if (message.action === "list") {
			send(socket, { kind: "agents", id: message.id, data: await listAgents(scope) });
			return;
		}
		throw new Error(`unsupported agents action: ${String((message as { action?: unknown }).action)}`);
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
