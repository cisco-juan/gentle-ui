import { batch, createSignal, type Accessor } from "solid-js";
import type { ExtensionUiRequest, ExtensionUiResponse, ServerMessage, SessionSummary, UploadedFile } from "@gentle-shell/protocol";
import { BridgeClient } from "../lib/bridge";
import { describeCommand, isRunnableCommand } from "../lib/commands";
import {
	IMAGE_ONLY_PROMPT,
	buildImages,
	composePrompt,
	describeAttachment,
	readAsBase64,
	sanitizeName,
	uploadedPaths,
	type Attachment,
	type FileLike,
	type PromptImage,
} from "../lib/attachments";
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
	| { kind: "notice"; id: string; text: string; tone: "info" | "warning" | "error"; repeat?: number };

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
	/** Transient line for informational agent notices, which must not fill the transcript. */
	readonly hint: Accessor<string>;
	readonly permissionMode: Accessor<string>;
	readonly threads: Accessor<readonly SessionSummary[]>;
	/** Session file the open thread is showing, `null` for a thread with no file yet. */
	readonly activePath: Accessor<string | null>;
	/** Live socket, so panels outside the transcript can ask their own questions. */
	readonly bridge: Accessor<BridgeClient | null>;
	readonly currentThread: Accessor<string | null>;
	/** Files dropped or pasted on the composer that have not been sent yet. */
	readonly attachments: Accessor<readonly Attachment[]>;
	/** Read, classify and upload dropped files. Failures land in the transcript, never as a silent drop. */
	attachFiles(files: readonly FileLike[]): Promise<void>;
	removeAttachment(id: string): void;
	/** Send any allow-listed Pi command through the open thread. */
	invoke<T>(command: string, params?: Record<string, unknown>): Promise<T>;
	connect(): Promise<void>;
	/** `attachments` defaults to the composer's pending list, which is drained either way. */
	send(text: string, attachments?: readonly Attachment[]): Promise<void>;
	interrupt(): Promise<void>;
	newThread(): Promise<void>;
	switchThread(path: string): Promise<void>;
	refreshThreads(): Promise<void>;
	answerPermission(requestId: string, response: ExtensionUiResponse): void;
	/** Surfaces a message in the transcript from outside the agent stream. */
	notify(text: string, tone?: "info" | "warning" | "error"): void;
	loadModels(): Promise<void>;
	switchModel(provider: string, modelId: string): Promise<void>;
	runCommand(name: string): Promise<void>;
	setPermissionMode(mode: string): Promise<void>;
}

/**
 * The controller the app created, for the composer.
 *
 * `App.tsx` owns the wiring and passes the composer only `onSend(text)`, so the composer cannot reach
 * the controller through props. Attachments live in this controller (they are chat state: they survive a
 * send, a failure and a redraw), and the composer reads them from here.
 */
let live: ChatController | null = null;

export function liveChat(): ChatController | null {
	return live;
}

const LAST_THREAD_KEY = "gentle-shell:last-thread:v1";

/** The thread this install was last in, so a relaunch lands where the work was left. */
function readLastThread(): string | null {
	try {
		return window.localStorage.getItem(LAST_THREAD_KEY);
	} catch {
		return null;
	}
}

function writeLastThread(path: string): void {
	try {
		window.localStorage.setItem(LAST_THREAD_KEY, path);
	} catch {
		// Remembering the thread is a convenience, not a requirement.
	}
}

function forgetLastThread(): void {
	try {
		window.localStorage.removeItem(LAST_THREAD_KEY);
	} catch {
		// Nothing to do: an unreadable store is already the fallback.
	}
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
	const [hint, setHint] = createSignal("");
	let hintTimer: ReturnType<typeof setTimeout> | undefined;
	const [threads, setThreads] = createSignal<readonly SessionSummary[]>([]);
	const [activePath, setActivePath] = createSignal<string | null>(null);
	const [attachments, setAttachments] = createSignal<readonly Attachment[]>([]);

	let client: BridgeClient | null = null;
	let threadId: string | null = null;
	let counter = 0;
	let attachmentCounter = 0;

	const nextId = (): string => `item-${++counter}`;

	function append(item: ChatItem): void {
		setItems((current) => {
			// The agent can repeat the same notice (a registry refresh, a retry); collapsing identical
			// consecutive lines keeps the transcript readable instead of burying the conversation.
			const last = current[current.length - 1];
			if (
				item.kind === "notice" &&
				last?.kind === "notice" &&
				last.text === item.text &&
				(last.repeat ?? 1) < 99
			) {
				const merged: ChatItem = { ...last, repeat: (last.repeat ?? 1) + 1 };
				return [...current.slice(0, -1), merged];
			}
			return [...current, item];
		});
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
			// Informational notices (registry refreshes, retries) are ambient, not conversation: they go
			// to the status line and fade, so the transcript stays about the work.
			const warning = record.notifyType === "warning";
			if (record.notifyType === "error" || warning) {
				append({
					kind: "notice",
					id: nextId(),
					text: String(record.message ?? ""),
					tone: record.notifyType === "error" ? "error" : "warning",
				});
				return;
			}
			setHint(String(record.message ?? ""));
			if (hintTimer !== undefined) clearTimeout(hintTimer);
			hintTimer = setTimeout(() => setHint(""), 8000);
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
			if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__bridge = next;
			setActivePath(sessionFileOf(opened.state));
			setConnection("connected");
			await bootstrap(next, opened.state);
			await loadHistory(next, opened.threadId);
			await refreshThreads();

			// A workspace you come back to should be the one you left: reopen the thread you were in,
			// and fall back to the fresh session when that file is gone.
			const remembered = readLastThread();
			const current = (opened.state as { sessionFile?: string } | null)?.sessionFile ?? null;
			if (remembered !== null && remembered !== current) {
				await switchThread(remembered).catch(() => forgetLastThread());
			}
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

	/**
	 * Send one prompt: the typed text plus whatever the composer attached.
	 *
	 * `App.tsx` wires the composer with a one-argument `onSend`, so the composer's attachments arrive
	 * through this controller's own list and are drained here. A caller that passes `attachments`
	 * explicitly wins, and the list is cleared either way; the palette and the chips call `send` with one
	 * argument and stage nothing, so they keep behaving exactly as before.
	 */
	async function send(text: string, explicit?: readonly Attachment[]): Promise<void> {
		const staged = takeAttachments();
		const attached = explicit ?? staged;

		const pathless = attached.find((entry) => entry.kind === "file" && entry.path === undefined);
		if (pathless !== undefined) {
			restoreAttachments(staged);
			append({ kind: "notice", id: nextId(), text: `still uploading ${pathless.name}`, tone: "warning" });
			return;
		}

		const images = buildImages(attached);
		const message = composePrompt(text, uploadedPaths(attached)) || (images.length > 0 ? IMAGE_ONLY_PROMPT : "");
		if (message.length === 0) return;

		if (!client || !threadId) {
			restoreAttachments(staged);
			if (attached.length > 0) {
				append({ kind: "notice", id: nextId(), text: "the agent is not connected; the attachment was kept", tone: "error" });
			}
			return;
		}

		await prompt(message, images);
	}

	/** The one way a prompt reaches Pi, so a command and a typed message behave the same. */
	async function prompt(message: string, images: readonly PromptImage[] = []): Promise<void> {
		if (!client || !threadId || message.length === 0) return;

		// Every path that can start a prompt ends here — composer, palette, chips — so this is the one
		// place that keeps a terminal-only command from leaving and coming back as "requires TUI mode".
		const slash = message.startsWith("/") ? (message.slice(1).split(/\s+/)[0] ?? "") : "";
		if (slash.length > 0 && !isRunnableCommand(slash)) {
			const described = describeCommand(slash);
			append({
				kind: "notice",
				id: nextId(),
				text: `/${slash} only works in a terminal: ${described.note ?? "it needs a terminal view"}.${
					described.surface ? ` Use ${described.surface} here instead.` : ""
				}`,
				tone: "warning",
			});
			return;
		}
		append({ kind: "user", id: nextId(), text: message });
		setRunning(true);
		try {
			await client.command(threadId, "prompt", images.length > 0 ? { message, images } : { message });
		} catch (error) {
			setRunning(false);
			append({ kind: "notice", id: nextId(), text: errorText(error), tone: "error" });
		}
	}

	function takeAttachments(): readonly Attachment[] {
		const current = attachments();
		if (current.length > 0) setAttachments([]);
		return current;
	}

	function restoreAttachments(entries: readonly Attachment[]): void {
		if (entries.length > 0) setAttachments((current) => [...entries, ...current]);
	}

	async function attachFiles(files: readonly FileLike[]): Promise<void> {
		if (files.length === 0) return;
		if (!client) {
			append({
				kind: "notice",
				id: nextId(),
				text: "the agent is not connected; drop the file again once it is",
				tone: "error",
			});
			return;
		}

		for (const file of files) {
			let dataBase64: string;
			try {
				// The bridge's own rule, checked before the round trip: a name it would refuse never uploads.
				sanitizeName(file.name);
				dataBase64 = await readAsBase64(file);
			} catch (error) {
				append({ kind: "notice", id: nextId(), text: `cannot attach ${file.name}: ${errorText(error)}`, tone: "error" });
				continue;
			}

			const id = `attachment-${++attachmentCounter}`;
			const entry = describeAttachment(id, file, dataBase64);
			setAttachments((current) => [...current, entry]);
			// An image travels inside the prompt, so it needs no path on disk.
			if (entry.kind === "image") continue;

			try {
				const saved = await uploadFile(options.url, file.name, dataBase64);
				setAttachments((current) =>
					current.map((item) => (item.id === id ? { ...item, status: "ready", path: saved.path } : item)),
				);
			} catch (error) {
				setAttachments((current) => current.filter((item) => item.id !== id));
				append({
					kind: "notice",
					id: nextId(),
					text: `could not attach ${file.name}: ${errorText(error)}`,
					tone: "error",
				});
			}
		}
	}

	function removeAttachment(id: string): void {
		setAttachments((current) => current.filter((entry) => entry.id !== id));
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
			writeLastThread(path);
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
		} catch (error) {
			// A missing index must not break the chat, but it must not vanish either: an empty rail
			// with no explanation is indistinguishable from "you have no threads".
			console.error("the thread list could not be read", error);
			setHint(`could not list threads: ${error instanceof Error ? error.message : String(error)}`);
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

	function notify(text: string, tone: "info" | "warning" | "error" = "info"): void {
		append({ kind: "notice", id: nextId(), text, tone });
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
		// Deliberately not `send`: a palette command must not pick up files staged in the composer.
		await prompt(`/${name}`);
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

	const controller: ChatController = {
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
		hint,
		threads,
		activePath,
		bridge: () => client,
		currentThread: () => threadId,
		attachments,
		attachFiles,
		removeAttachment,
		invoke,
		connect,
		send,
		interrupt,
		newThread,
		switchThread,
		refreshThreads,
		answerPermission,
		notify,
		loadModels,
		switchModel,
		runCommand,
		setPermissionMode,
	};

	live = controller;
	return controller;
}

let uploadCounter = 0;

/**
 * Write one attachment through the bridge.
 *
 * An upload is a bridge request, not a Pi command, and `BridgeClient` speaks only thread commands, so
 * the upload opens its own tokenised socket, asks once and closes. It is loopback: the cost is one
 * handshake per file, not a round trip per chunk.
 */
function uploadFile(url: string, name: string, dataBase64: string): Promise<UploadedFile> {
	return new Promise((resolve, reject) => {
		const id = `upload-${++uploadCounter}`;
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		let settled = false;
		const finish = (settle: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.close();
			settle();
		};
		const timer = setTimeout(() => finish(() => reject(new Error("the bridge did not answer the upload"))), 30_000);

		socket.addEventListener("open", () => {
			socket.send(JSON.stringify({ kind: "upload", id, name, dataBase64 }));
		});
		socket.addEventListener("message", (event) => {
			let message: ServerMessage;
			try {
				message = JSON.parse(String(event.data)) as ServerMessage;
			} catch {
				return;
			}
			if (message.kind === "upload" && message.id === id) finish(() => resolve(message.data));
			else if (message.kind === "error" && message.id === id) finish(() => reject(new Error(message.message)));
		});
		socket.addEventListener("error", () => finish(() => reject(new Error(`cannot reach the bridge at ${url}`))));
		socket.addEventListener("close", () => finish(() => reject(new Error("the bridge closed the upload connection"))));
	});
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
