import { batch, createSignal, type Accessor } from "solid-js";
import type { ExtensionUiRequest, ExtensionUiResponse, ServerMessage, SessionSummary } from "@gentle-shell/protocol";
import { BridgeClient } from "../lib/bridge";
import { textOf, type AssistantMessage, type AssistantStreamEvent, type ContentBlock, type PiEnvelope, type ToolResultPayload } from "../lib/records";

export type ChatItem =
	| { kind: "user"; id: string; text: string }
	| { kind: "assistant"; id: string; text: string; model?: string; cost?: number }
	| {
			kind: "tool";
			id: string;
			callId: string;
			name: string;
			args: unknown;
			output: string;
			status: "running" | "done" | "error";
			durationMs?: number;
	  }
	| { kind: "permission"; id: string; request: ExtensionUiRequest; answer: string | null }
	| { kind: "notice"; id: string; text: string; tone: "info" | "warning" | "error" };

export interface ChatController {
	readonly items: Accessor<ChatItem[]>;
	readonly draft: Accessor<string>;
	readonly running: Accessor<boolean>;
	readonly connection: Accessor<"connecting" | "connected" | "failed">;
	readonly model: Accessor<string>;
	readonly cost: Accessor<number>;
	readonly statuses: Accessor<Record<string, string>>;
	readonly commands: Accessor<Array<{ name: string; description: string }>>;
	readonly models: Accessor<Array<{ provider: string; id: string; contextWindow?: number }>>;
	readonly profile: Accessor<string>;
	readonly permissionMode: Accessor<string>;
	readonly threads: Accessor<readonly SessionSummary[]>;
	/** Session file the open thread is showing, `null` for a thread with no file yet. */
	readonly activePath: Accessor<string | null>;
	/** Live socket, so panels outside the transcript can ask their own questions. */
	readonly bridge: Accessor<BridgeClient | null>;
	readonly currentThread: Accessor<string | null>;
	/** Send any allow-listed Pi command through the open thread. */
	invoke<T>(command: string, params?: Record<string, unknown>): Promise<T>;
	connect(): Promise<void>;
	send(text: string): Promise<void>;
	interrupt(): Promise<void>;
	newThread(): Promise<void>;
	switchThread(path: string): Promise<void>;
	refreshThreads(): Promise<void>;
	answerPermission(requestId: string, response: ExtensionUiResponse): void;
	loadModels(): Promise<void>;
	switchModel(provider: string, modelId: string): Promise<void>;
	runCommand(name: string): Promise<void>;
	setPermissionMode(mode: string): Promise<void>;
}

/** Translate Pi's record stream into renderable chat items. */
export function createChatController(options: { url: string; cwd: string }): ChatController {
	const [items, setItems] = createSignal<ChatItem[]>([]);
	const [draft, setDraft] = createSignal("");
	const [running, setRunning] = createSignal(false);
	const [connection, setConnection] = createSignal<"connecting" | "connected" | "failed">("connecting");
	const [model, setModel] = createSignal("");
	const [cost, setCost] = createSignal(0);
	const [statuses, setStatuses] = createSignal<Record<string, string>>({});
	const [commands, setCommands] = createSignal<Array<{ name: string; description: string }>>([]);
	const [models, setModels] = createSignal<Array<{ provider: string; id: string; contextWindow?: number }>>([]);
	const [profile] = createSignal("default");
	const [permissionMode, setPermissionModeSignal] = createSignal("normal");
	const [threads, setThreads] = createSignal<readonly SessionSummary[]>([]);
	const [activePath, setActivePath] = createSignal<string | null>(null);

	let client: BridgeClient | null = null;
	let threadId: string | null = null;
	let counter = 0;

	const nextId = (): string => `item-${++counter}`;

	function append(item: ChatItem): void {
		setItems((current) => [...current, item]);
	}

	function patch(callId: string, change: Partial<Extract<ChatItem, { kind: "tool" }>>): void {
		setItems((current) =>
			current.map((item) => (item.kind === "tool" && item.callId === callId ? { ...item, ...change } : item)),
		);
	}

	/** Commit streaming text before anything else lands below it. */
	function flushDraft(): void {
		const text = draft().trim();
		if (text.length === 0) {
			setDraft("");
			return;
		}
		append({ kind: "assistant", id: nextId(), text });
		setDraft("");
	}

	function handle(message: ServerMessage): void {
		if (message.kind === "log") return;
		if (message.kind === "exited") {
			setRunning(false);
			append({ kind: "notice", id: nextId(), text: "The agent process exited. Reconnect to continue.", tone: "error" });
			return;
		}
		if (message.kind === "error") {
			append({ kind: "notice", id: nextId(), text: message.message, tone: "error" });
			return;
		}
		if (message.kind === "ui-request") {
			flushDraft();
			append({ kind: "permission", id: nextId(), request: message.request, answer: null });
			return;
		}
		if (message.kind !== "record") return;

		const record = message.record as PiEnvelope;
		const type = record.type;

		if (type === "extension_ui_request") {
			handleFireAndForget(record);
			return;
		}
		if (type === "agent_start") {
			setRunning(true);
			return;
		}
		if (type === "agent_settled") {
			batch(() => {
				flushDraft();
				setRunning(false);
			});
			return;
		}
		if (type === "message_start") {
			const message_ = record.message as AssistantMessage | undefined;
			if (message_?.role === "assistant") setDraft("");
			return;
		}
		if (type === "message_update") {
			const update = record.assistantMessageEvent as AssistantStreamEvent | undefined;
			if (update?.type === "text_delta" && typeof update.delta === "string") {
				setDraft((current) => current + update.delta);
			}
			return;
		}
		if (type === "message_end") {
			const ended = record.message as AssistantMessage | undefined;
			if (ended?.role !== "assistant") return;
			const text = textOf(ended.content);
			const spent = ended.usage?.cost?.total;
			if (typeof spent === "number") setCost((current) => current + spent);
			if (ended.model) setModel(ended.model);
			batch(() => {
				if (text.trim().length > 0) {
					append({
						kind: "assistant",
						id: nextId(),
						text,
						...(ended.model === undefined ? {} : { model: ended.model }),
						...(spent === undefined ? {} : { cost: spent }),
					});
				}
				setDraft("");
			});
			return;
		}
		if (type === "tool_execution_start") {
			flushDraft();
			const callId = String(record.toolCallId ?? nextId());
			append({
				kind: "tool",
				id: nextId(),
				callId,
				name: String(record.toolName ?? "tool"),
				args: record.args ?? {},
				output: "",
				status: "running",
			});
			return;
		}
		if (type === "tool_execution_update") {
			const partial = record.partialResult as ToolResultPayload | undefined;
			patch(String(record.toolCallId ?? ""), { output: textOf(partial?.content) });
			return;
		}
		if (type === "tool_execution_end") {
			const result = record.result as ToolResultPayload | undefined;
			const structured = result?.structuredContent;
			const output = textOf(result?.content) || (structured ? JSON.stringify(structured, null, 2) : "");
			patch(String(record.toolCallId ?? ""), {
				output,
				status: record.isError === true ? "error" : "done",
				...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
			});
		}
	}

	function handleFireAndForget(record: PiEnvelope): void {
		const method = record.method;
		if (method === "setStatus") {
			const key = String(record.statusKey ?? "status");
			const text = String(record.statusText ?? "");
			setStatuses((current) => {
				const next = { ...current };
				if (text.length === 0) delete next[key];
				else next[key] = text;
				return next;
			});
			return;
		}
		if (method === "notify") {
			const tone = record.notifyType === "error" ? "error" : record.notifyType === "warning" ? "warning" : "info";
			append({ kind: "notice", id: nextId(), text: String(record.message ?? ""), tone });
		}
	}

	async function connect(): Promise<void> {
		setConnection("connecting");
		const next = new BridgeClient(options.url);
		try {
			await next.connect();
			next.subscribe(handle);
			const opened = await next.open(options.cwd);
			threadId = opened.threadId;
			client = next;
			setActivePath(sessionFileOf(opened.state));
			setConnection("connected");
			await bootstrap(next, opened.state);
			await loadHistory(next, opened.threadId);
			await refreshThreads();
		} catch (error) {
			setConnection("failed");
			append({
				kind: "notice",
				id: nextId(),
				text: error instanceof Error ? error.message : String(error),
				tone: "error",
			});
		}
	}

	async function bootstrap(active: BridgeClient, state: unknown): Promise<void> {
		const view = state as { model?: { id?: string } } | null;
		if (view?.model?.id) setModel(view.model.id);
		try {
			const listed = await active.command<{ commands: Array<{ name: string; description: string }> }>(
				threadId as string,
				"get_commands",
			);
			applyCommands(listed.commands ?? []);
		} catch {
			// A missing command list is not fatal: the composer still sends plain prompts.
		}
	}

	async function send(text: string): Promise<void> {
		const message = text.trim();
		if (message.length === 0 || !client || !threadId) return;
		append({ kind: "user", id: nextId(), text: message });
		setRunning(true);
		try {
			await client.command(threadId, "prompt", { message });
		} catch (error) {
			setRunning(false);
			append({
				kind: "notice",
				id: nextId(),
				text: error instanceof Error ? error.message : String(error),
				tone: "error",
			});
		}
	}

	async function interrupt(): Promise<void> {
		if (!client || !threadId) return;
		try {
			await client.command(threadId, "abort");
			await client.command(threadId, "clear_queue");
		} catch {
			// Already idle: nothing to interrupt.
		}
	}

	async function newThread(): Promise<void> {
		if (!client || !threadId) return;
		flushDraft();
		batch(() => {
			setItems([]);
			setDraft("");
			setCost(0);
			setActivePath(null);
		});
		try {
			await client.command(threadId, "new_session");
		} catch (error) {
			append({
				kind: "notice",
				id: nextId(),
				text: error instanceof Error ? error.message : String(error),
				tone: "error",
			});
		}
		await refreshThreads();
	}

	/** Switch the open Pi thread to a session file and redraw the transcript from its history. */
	async function switchThread(path: string): Promise<void> {
		if (!client || !threadId || path === activePath()) return;
		const active = client;
		const id = threadId;
		try {
			await active.command(id, "switch_session", { sessionPath: path });
			batch(() => {
				setItems([]);
				setDraft("");
				setCost(0);
				setActivePath(path);
			});
			await loadHistory(active, id);
			await refreshState(active, id);
		} catch (error) {
			append({
				kind: "notice",
				id: nextId(),
				text: error instanceof Error ? error.message : String(error),
				tone: "error",
			});
			return;
		}
		await refreshThreads();
	}

	/** Re-read the live state so the model chip describes the thread that is now open. */
	async function refreshState(active: BridgeClient, id: string): Promise<void> {
		const state = await active.command<{ model?: { id?: string } }>(id, "get_state").catch(() => null);
		const modelId = state?.model?.id;
		if (typeof modelId === "string" && modelId.length > 0) setModel(modelId);
	}

	/** Re-read the bridge's session index. Failures keep the rail on its last known list. */
	async function refreshThreads(): Promise<void> {
		if (!client) return;
		try {
			setThreads(await client.sessions());
		} catch {
			// The bridge may be older than this UI; a missing index must not break the chat.
		}
	}

	/** Replay a session's user and assistant text; system and tool traffic stays out of the pane. */
	async function loadHistory(active: BridgeClient, id: string): Promise<void> {
		let messages: readonly HistoryMessage[] = [];
		try {
			const listed = await active.command<{ messages?: readonly HistoryMessage[] }>(id, "get_messages");
			messages = listed.messages ?? [];
		} catch {
			return;
		}

		const history: ChatItem[] = [];
		for (const message of messages) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = textOf(message.content).trim();
			if (text.length === 0) continue;
			if (message.role === "user") {
				history.push({ kind: "user", id: nextId(), text });
				continue;
			}
			const model_ = message.model;
			history.push({
				kind: "assistant",
				id: nextId(),
				text,
				...(typeof model_ === "string" && model_.length > 0 ? { model: model_ } : {}),
			});
		}
		setItems(history);
	}

	function answerPermission(requestId: string, response: ExtensionUiResponse): void {
		if (!client || !threadId) return;
		client.answer(threadId, requestId, response);
		setItems((current) =>
			current.map((item) =>
				item.kind === "permission" && item.request.id === requestId
					? { ...item, answer: response.cancelled ? "cancelled" : String(response.value ?? response.confirmed ?? "") }
					: item,
			),
		);
	}

	function errorText(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function applyCommands(list: Array<{ name: string; description: string }>): void {
		setCommands(list);
	}

	async function loadModels(): Promise<void> {
		if (!client || !threadId) return;
		try {
			const listed = await client.command<
				Array<{ provider: string; id: string; contextWindow?: number }> | { models?: Array<{ provider: string; id: string }> }
			>(threadId, "get_available_models");
			setModels(Array.isArray(listed) ? listed : (listed.models ?? []));
		} catch (error) {
			append({ kind: "notice", id: nextId(), text: errorText(error), tone: "error" });
		}
	}

	async function switchModel(provider: string, modelId: string): Promise<void> {
		if (!client || !threadId) return;
		try {
			await client.command(threadId, "set_model", { provider, model: modelId });
			setModel(modelId);
		} catch (error) {
			append({ kind: "notice", id: nextId(), text: errorText(error), tone: "error" });
		}
	}

	/** Slash commands are plain prompts to Pi, so the UI needs no private control channel for them. */
	async function runCommand(name: string): Promise<void> {
		await send(`/${name}`);
	}

	async function setPermissionMode(mode: string): Promise<void> {
		setPermissionModeSignal(mode);
		const command = commands().find((entry) => entry.name.includes("permission"));
		if (command) await runCommand(command.name);
	}

	function invoke<T>(command: string, params: Record<string, unknown> = {}): Promise<T> {
		if (!client || !threadId) return Promise.reject(new Error("the agent is not connected"));
		return client.command<T>(threadId, command, params);
	}

	return {
		items,
		draft,
		running,
		connection,
		model,
		cost,
		statuses,
		commands,
		models,
		profile,
		permissionMode,
		threads,
		activePath,
		bridge: () => client,
		currentThread: () => threadId,
		invoke,
		connect,
		send,
		interrupt,
		newThread,
		switchThread,
		refreshThreads,
		answerPermission,
		loadModels,
		switchModel,
		runCommand,
		setPermissionMode,
	};
}

interface HistoryMessage {
	readonly role: string;
	readonly content?: string | readonly ContentBlock[];
	readonly model?: string;
}

/** Session file the `open` handshake reported, when it named one. */
function sessionFileOf(state: unknown): string | null {
	const view = state as { sessionFile?: unknown } | null;
	return typeof view?.sessionFile === "string" && view.sessionFile.length > 0 ? view.sessionFile : null;
}
