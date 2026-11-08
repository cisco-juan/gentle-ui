import { batch, createSignal, type Accessor } from "solid-js";
import type {
	ExtensionUiRequest,
	ExtensionUiResponse,
	HistoryEntry,
	ServerMessage,
	SessionSummary,
	UploadedFile,
} from "@gentle-shell/protocol";
import { BridgeClient } from "../lib/bridge";
import { checkCommand, shellAction, unknownCommandNotice } from "../lib/commands";
import { setModelParams } from "../lib/models";
import { readCachedThreads, writeCachedThreads, type TextStorage } from "../lib/thread-cache";
import { answerLabel } from "../lib/permission";
import { extensionErrorText, promptParams, startsRun, wasCancelled } from "../lib/prompt-outcome";
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
import { textOf, thinkingOf, type AssistantMessage, type AssistantStreamEvent, type ContentBlock, type PiEnvelope, type ToolResultPayload } from "../lib/records";
import { streamIntent } from "../lib/stream";

export type ChatItem =
	| { kind: "user"; id: string; text: string }
	| { kind: "assistant"; id: string; text: string; model?: string; cost?: number }
	/** The model's own reasoning, streamed before its answer; kept so a reopened thread shows the work. */
	| { kind: "thinking"; id: string; text: string; status: "running" | "done" }
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
	readonly connection: Accessor<"connecting" | "connected" | "failed" | "disconnected">;
	readonly model: Accessor<string>;
	readonly cost: Accessor<number>;
	readonly statuses: Accessor<Record<string, string>>;
	readonly commands: Accessor<Array<{ name: string; description: string }>>;
	readonly models: Accessor<Array<{ provider: string; id: string; contextWindow?: number }>>;
	readonly profile: Accessor<string>;
	/** Transient line for informational agent notices, which must not fill the transcript. */
	readonly hint: Accessor<string>;
	readonly threads: Accessor<readonly SessionSummary[]>;
	/** True until the bridge has answered for the first time, so the rail can show a skeleton, not "no threads". */
	readonly threadsLoading: Accessor<boolean>;
	/** The thread being opened, from the click until its history is on screen; null otherwise. */
	readonly opening: Accessor<string | null>;
	/** True while the model list is being asked for. */
	readonly modelsLoading: Accessor<boolean>;
	/** True while an older page of the transcript is on its way. */
	readonly older: Accessor<boolean>;
	/** True when the open session file holds conversation older than what is on screen. */
	readonly hasOlder: Accessor<boolean>;
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
	/** Prepend the next older page of the open session, keeping what is already on screen. */
	loadOlder(): Promise<void>;
	connect(): Promise<void>;
	/** Open a fresh connection and land back in the thread that was on screen. */
	reconnect(): Promise<void>;
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
	/** Like `switchModel`, but a refusal rejects instead of becoming a notice, for callers that report it themselves. */
	selectModel(provider: string, modelId: string): Promise<void>;
	runCommand(name: string): Promise<void>;
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

/** `localStorage`, or null where the browser will not hand it over (a private window, blocked site data). */
function threadStorage(): TextStorage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
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
	const [connection, setConnection] = createSignal<"connecting" | "connected" | "failed" | "disconnected">("connecting");
	const [model, setModel] = createSignal("");
	const [cost, setCost] = createSignal(0);
	const [statuses, setStatuses] = createSignal<Record<string, string>>({});
	const [commands, setCommands] = createSignal<Array<{ name: string; description: string }>>([]);
	const [models, setModels] = createSignal<Array<{ provider: string; id: string; contextWindow?: number }>>([]);
	const [profile] = createSignal("default");
	const [hint, setHint] = createSignal("");
	let hintTimer: ReturnType<typeof setTimeout> | undefined;
	// The last list the bridge gave, so a relaunch paints the rail at once and corrects it when the answer comes.
	const [threads, setThreads] = createSignal<readonly SessionSummary[]>(readCachedThreads(threadStorage() ?? { getItem: () => null, setItem: () => undefined }));
	const [threadsLoading, setThreadsLoading] = createSignal(true);
	const [opening, setOpening] = createSignal<string | null>(null);
	const [modelsLoading, setModelsLoading] = createSignal(false);
	const [older, setOlder] = createSignal(false);
	const [hasOlder, setHasOlder] = createSignal(false);
	const [activePath, setActivePath] = createSignal<string | null>(null);
	const [attachments, setAttachments] = createSignal<readonly Attachment[]>([]);

	let client: BridgeClient | null = null;
	/** Detaches the listeners of the current connection. */
	let teardown: (() => void) | null = null;
	let connecting = false;
	/** The connection being set up or in use; an answer that belongs to an older one is dropped. */
	let current: BridgeClient | null = null;
	let threadId: string | null = null;
	let counter = 0;
	let attachmentCounter = 0;
	/** Cursor for the next older page; null once the start of the conversation is on screen. */
	let historyCursor: number | null = null;
	/** Entry ids already rendered, so a page that overlaps one on screen cannot duplicate it. */
	const seenEntries = new Set<string>();

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

	/** The thinking block still streaming: its deltas land in one item instead of one item per token. */
	let openThinking: string | null = null;

	function appendThinking(delta: string): void {
		const id = openThinking;
		if (id === null) {
			const created = nextId();
			openThinking = created;
			// Committing the reply first keeps the transcript in the order the work happened.
			flushDraft();
			append({ kind: "thinking", id: created, text: delta, status: "running" });
			return;
		}
		setItems((current) =>
			current.map((item) =>
				item.kind === "thinking" && item.id === id ? { ...item, text: item.text + delta } : item,
			),
		);
	}

	function closeThinking(): void {
		const id = openThinking;
		if (id === null) return;
		openThinking = null;
		setItems((current) =>
			current.map((item) => (item.kind === "thinking" && item.id === id ? { ...item, status: "done" } : item)),
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
			// The bridge is up but this thread's agent is gone, so nothing sent from here can arrive.
			threadId = null;
			batch(() => {
				setRunning(false);
				setConnection("disconnected");
			});
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
		if (type === "extension_error") {
			append({ kind: "notice", id: nextId(), text: extensionErrorText(record), tone: "error" });
			return;
		}
		if (type === "agent_start") {
			setRunning(true);
			return;
		}
		if (type === "agent_settled") {
			batch(() => {
				closeThinking();
				flushDraft();
				setRunning(false);
			});
			return;
		}
		if (type === "message_start") {
			const message_ = record.message as AssistantMessage | undefined;
			if (message_?.role === "assistant") {
				closeThinking();
				setDraft("");
			}
			return;
		}
		if (type === "message_update") {
			const update = record.assistantMessageEvent as AssistantStreamEvent | undefined;
			if (update === undefined) return;
			// A thinking block ends before the answer starts; closing it here keeps the transcript honest
			// about what is still in flight.
			if (update.type === "thinking_end") {
				closeThinking();
				return;
			}
			const intent = streamIntent(update);
			if (intent.kind === "text") {
				setDraft((current) => current + intent.delta);
				return;
			}
			if (intent.kind === "thinking") appendThinking(intent.delta);
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
				closeThinking();
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

	/** Stops listening to, and closes, whatever connection is current. Safe to call with none. */
	function dropClient(): void {
		teardown?.();
		teardown = null;
		client?.close();
		client = null;
		current = null;
		threadId = null;
	}

	/** The socket ended without being asked to: say so, and stop pretending the agent is reachable. */
	function lost(dropped: BridgeClient): void {
		// A socket that is not the current one was already replaced; its close is old news.
		if (client !== dropped) return;
		client = null;
		threadId = null;
		batch(() => {
			setRunning(false);
			setConnection("disconnected");
		});
		append({
			kind: "notice",
			id: nextId(),
			text: "The connection to the bridge was lost. Reconnect to continue.",
			tone: "error",
		});
	}

	async function connect(): Promise<void> {
		if (connecting) return;
		connecting = true;
		// Where to land again after a drop: the thread on screen, else the one this install was last in.
		const resume = activePath() ?? readLastThread();
		dropClient();
		setConnection("connecting");
		if (threads().length === 0) setThreadsLoading(true);
		const next = new BridgeClient(options.url);
		current = next;
		try {
			await next.connect();
			const stopRecords = next.subscribe(handle);
			const stopClose = next.onClose(() => lost(next));
			teardown = () => {
				stopRecords();
				stopClose();
			};
			// The session index is the bridge's own work and does not need Pi, which takes ~2 s to start:
			// asking now puts the rail on screen long before the agent is ready.
			void loadThreads(next);
			const opened = await next.open(options.cwd);
			threadId = opened.threadId;
			client = next;
			if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__bridge = next;
			setActivePath(sessionFileOf(opened.state));
			setConnection("connected");
			await bootstrap(next, opened.state);
			await loadHistory(next, opened.threadId);

			// A workspace you come back to should be the one you left: reopen the thread you were in,
			// and fall back to the fresh session when that file is gone.
			const current = sessionFileOf(opened.state);
			if (resume !== null && resume !== current) {
				// A thread that is gone is forgotten quietly: an error on every launch helps nobody.
				if (!(await openThread(resume, { quiet: true }))) forgetLastThread();
			}
		} catch (error) {
			// A socket that opened but never finished the handshake would stay open and subscribed.
			teardown?.();
			teardown = null;
			next.close();
			client = null;
			current = null;
			threadId = null;
			setConnection("failed");
			setThreadsLoading(false);
			append({
				kind: "notice",
				id: nextId(),
				text: error instanceof Error ? error.message : String(error),
				tone: "error",
			});
		} finally {
			connecting = false;
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
			append({
				kind: "notice",
				id: nextId(),
				text:
					attached.length > 0
						? "the agent is not connected; the attachment was kept"
						: "the agent is not connected; nothing was sent",
				tone: "error",
			});
			return;
		}

		await prompt(message, images);
	}

	/** The one way a prompt reaches Pi, so a command and a typed message behave the same. */
	async function prompt(message: string, images: readonly PromptImage[] = []): Promise<void> {
		if (!client || !threadId || message.length === 0) return;

		// Every path that can start a prompt ends here — composer, palette, chips — so this is the one
		// place that keeps a terminal-only command from leaving and coming back as "requires TUI mode".
		const firstLine = message.split("\n")[0] ?? "";
		// Bare /gentle:profiles is a terminal screen; the shell answers it with its own sheet.
		if (shellAction(firstLine) === "profiles") {
			document.dispatchEvent(new CustomEvent("gentle:open-profiles"));
			return;
		}
		if (firstLine.startsWith("/")) {
			const verdict = checkCommand(firstLine);
			if (!verdict.runnable) {
				const described = verdict.description;
				append({
					kind: "notice",
					id: nextId(),
					text: `/${firstLine.slice(1)} only works in a terminal: ${described.note ?? "it needs a terminal view"}.${
						described.surface ? ` Use ${described.surface} here instead.` : ""
					}`,
					tone: "warning",
				});
				return;
			}
			const mistyped = unknownCommandNotice(
				firstLine,
				commands().map((entry) => entry.name),
			);
			if (mistyped !== null) {
				append({ kind: "notice", id: nextId(), text: mistyped, tone: "warning" });
				return;
			}
		}
		// A prompt sent mid-run is queued behind it, so it must not end or restart the run in flight.
		const queued = running();
		append({ kind: "user", id: nextId(), text: message });
		setRunning(true);
		try {
			const answer = await client.command(threadId, "prompt", promptParams(message, images, queued));
			// An extension command finishes inside this call and never emits agent_settled.
			if (!queued && !startsRun(answer)) setRunning(false);
		} catch (error) {
			if (!queued) setRunning(false);
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
		// Pi emits nothing when it was already idle, so the UI cannot wait for an event to leave "working".
		setRunning(false);
	}

	async function newThread(): Promise<void> {
		if (!client || !threadId) return;
		const active = client;
		const id = threadId;
		// Pi would abort the run on its own; stopping it first keeps its last events out of the new thread.
		if (running()) await interrupt();
		flushDraft();
		let answer: unknown;
		try {
			answer = await active.command(id, "new_session");
		} catch (error) {
			// The transcript stays: a thread that failed to start must not erase the one on screen.
			append({ kind: "notice", id: nextId(), text: errorText(error), tone: "error" });
			return;
		}
		if (wasCancelled(answer)) {
			append({ kind: "notice", id: nextId(), text: "a new thread was not started: an extension cancelled it", tone: "warning" });
			return;
		}

		const state = await active.command<unknown>(id, "get_state").catch(() => null);
		const path = sessionFileOf(state);
		batch(() => {
			openThinking = null;
			resetHistoryPaging();
			setItems([]);
			setDraft("");
			setCost(0);
			setRunning(false);
			setHint("");
			setActivePath(path);
		});
		if (path !== null) writeLastThread(path);
		void refreshThreads();
	}

	/** Switch the open Pi thread to a session file and redraw the transcript from its history. */
	async function switchThread(path: string): Promise<void> {
		await openThread(path, { quiet: false });
	}

	/** Open a session file. Resolves false when it could not be opened; `quiet` keeps that out of the transcript. */
	async function openThread(path: string, options: { quiet: boolean }): Promise<boolean> {
		if (!client || !threadId) return false;
		if (path === activePath()) return true;
		const active = client;
		const id = threadId;
		if (running()) await interrupt();
		// From here the pane shows a skeleton and the row is marked: the switch takes a moment and used
		// to give no sign at all that the click had been heard.
		setOpening(path);
		try {
			const answer = await active.command(id, "switch_session", { sessionPath: path });
			if (wasCancelled(answer)) throw new Error("an extension cancelled switching threads");
			batch(() => {
				openThinking = null;
				resetHistoryPaging();
				setItems([]);
				setDraft("");
				setCost(0);
				setRunning(false);
				setHint("");
				setActivePath(path);
			});
			// The two reads do not depend on each other, so they travel together.
			await Promise.all([loadHistory(active, id), refreshState(active, id)]);
			writeLastThread(path);
		} catch (error) {
			if (!options.quiet) append({ kind: "notice", id: nextId(), text: errorText(error), tone: "error" });
			return false;
		} finally {
			setOpening(null);
		}
		// Refreshing the rail is not what the person is waiting for.
		void refreshThreads();
		return true;
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
		await loadThreads(client);
	}

	/** Ask `active` for the session index; an answer for a connection that has since been replaced is dropped. */
	async function loadThreads(active: BridgeClient): Promise<void> {
		try {
			const list = await active.sessions();
			if (current !== active) return;
			batch(() => {
				setThreads(list);
				setThreadsLoading(false);
			});
			const storage = threadStorage();
			if (storage !== null) writeCachedThreads(storage, list);
		} catch (error) {
			if (current !== active) return;
			setThreadsLoading(false);
			// A missing index must not break the chat, but it must not vanish either: an empty rail
			// with no explanation is indistinguishable from "you have no threads".
			console.error("the thread list could not be read", error);
			setHint(`could not list threads: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Forget the paging cursor: the thread on screen is no longer the one those pages belong to. */
	function resetHistoryPaging(): void {
		historyCursor = null;
		seenEntries.clear();
		setHasOlder(false);
		setOlder(false);
	}

	/**
	 * Replay a session's conversation, newest page first.
	 *
	 * Pi's `get_messages` answers with the tail of a session, so a long thread reopened as a handful of
	 * rows. The session file holds every turn and the bridge pages it backwards; `get_messages` stays as
	 * the fallback for a file the bridge cannot read, which is also what a fresh session is.
	 */
	async function loadHistory(active: BridgeClient, id: string): Promise<void> {
		const path = activePath();
		resetHistoryPaging();
		if (path !== null) {
			try {
				const page = await active.history({ sessionPath: path });
				// A page for a thread that is no longer on screen belongs nowhere.
				if (current !== active || activePath() !== path) return;
				const history = page.entries.filter((entry) => !seenEntries.has(entry.id)).flatMap((entry) => historyItems(entry));
				historyCursor = page.before;
				batch(() => {
					setItems(history);
					setHasOlder(page.before !== null);
				});
				return;
			} catch {
				// An unreadable file is not an empty thread: fall through to what Pi itself remembers.
			}
		}
		await loadPiMessages(active, id);
	}

	/** What Pi returns for `get_messages`: the tail of the session, rendered as before paging existed. */
	async function loadPiMessages(active: BridgeClient, id: string): Promise<void> {
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
			if (message.role === "user") {
				if (text.length === 0) continue;
				history.push({ kind: "user", id: nextId(), text });
				continue;
			}
			// A reopened thread shows the same work the live one did, in the same order.
			const thought = thinkingOf(message.content).trim();
			if (thought.length > 0) {
				history.push({ kind: "thinking", id: nextId(), text: thought, status: "done" });
			}
			if (text.length === 0) continue;
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

	/** The rows one history entry becomes, in the order the work happened. */
	function historyItems(entry: HistoryEntry): ChatItem[] {
		seenEntries.add(entry.id);
		if (entry.role === "user") {
			const text = entry.text.trim();
			return text.length === 0 ? [] : [{ kind: "user", id: nextId(), text }];
		}

		const rows: ChatItem[] = [];
		const thought = entry.thinking?.trim() ?? "";
		if (thought.length > 0) rows.push({ kind: "thinking", id: nextId(), text: thought, status: "done" });
		for (const tool of entry.tools) {
			rows.push({
				kind: "tool",
				id: nextId(),
				callId: tool.id,
				name: tool.name,
				args: tool.input,
				output: tool.output,
				status: tool.isError ? "error" : "done",
			});
		}
		const text = entry.text.trim();
		if (text.length > 0) {
			rows.push({
				kind: "assistant",
				id: nextId(),
				text,
				...(entry.model === null ? {} : { model: entry.model }),
			});
		}
		return rows;
	}

	/**
	 * Prepend the next older page of the open session.
	 *
	 * Called when the reader has climbed to the top. A page already in flight is not asked for twice, and
	 * an answer for a thread that has changed underneath is dropped; a failure leaves what is on screen
	 * alone instead of putting an error between the reader and the turns already there.
	 */
	async function loadOlder(): Promise<void> {
		const active = client;
		const path = activePath();
		const cursor = historyCursor;
		if (active === null || threadId === null || path === null || cursor === null || older()) return;

		setOlder(true);
		try {
			const page = await active.history({ sessionPath: path, before: cursor });
			if (current !== active || activePath() !== path) return;
			const prepended = page.entries
				.filter((entry) => !seenEntries.has(entry.id))
				.flatMap((entry) => historyItems(entry));
			historyCursor = page.before;
			batch(() => {
				setItems((onScreen) => [...prepended, ...onScreen]);
				setHasOlder(page.before !== null);
				// The skeleton leaves in the same commit the view measures, so its height is not counted
				// as new transcript and the reader does not jump past the row they were reading.
				setOlder(false);
			});
		} catch {
			// One failed read stops the retries; the turns already read stay on screen.
			setHasOlder(false);
		} finally {
			setOlder(false);
		}
	}

	function answerPermission(requestId: string, response: ExtensionUiResponse): void {
		if (!client || !threadId) {
			notify("the agent is not connected; the answer was not sent and the question is still open", "error");
			return;
		}
		try {
			client.answer(threadId, requestId, response);
		} catch (error) {
			// The card stays open: marking it answered would say the agent heard something it never got.
			notify(`the answer was not sent: ${errorText(error)}`, "error");
			return;
		}
		setItems((current) =>
			current.map((item) =>
				item.kind === "permission" && item.request.id === requestId
					? { ...item, answer: answerLabel(response) }
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
		setModelsLoading(true);
		try {
			const listed = await client.command<
				Array<{ provider: string; id: string; contextWindow?: number }> | { models?: Array<{ provider: string; id: string }> }
			>(threadId, "get_available_models");
			setModels(Array.isArray(listed) ? listed : (listed.models ?? []));
		} catch (error) {
			append({ kind: "notice", id: nextId(), text: errorText(error), tone: "error" });
		} finally {
			setModelsLoading(false);
		}
	}

	async function selectModel(provider: string, modelId: string): Promise<void> {
		if (!client || !threadId) throw new Error("the agent is not connected");
		await client.command(threadId, "set_model", setModelParams(provider, modelId));
		setModel(modelId);
	}

	async function switchModel(provider: string, modelId: string): Promise<void> {
		try {
			await selectModel(provider, modelId);
		} catch (error) {
			append({ kind: "notice", id: nextId(), text: errorText(error), tone: "error" });
		}
	}

	/** Slash commands are plain prompts to Pi, so the UI needs no private control channel for them. */
	async function runCommand(name: string): Promise<void> {
		// Deliberately not `send`: a palette command must not pick up files staged in the composer.
		await prompt(`/${name}`);
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
		hint,
		threads,
		threadsLoading,
		opening,
		modelsLoading,
		older,
		hasOlder,
		activePath,
		bridge: () => client,
		currentThread: () => threadId,
		attachments,
		attachFiles,
		removeAttachment,
		invoke,
		loadOlder,
		connect,
		reconnect: connect,
		send,
		interrupt,
		newThread,
		switchThread,
		refreshThreads,
		answerPermission,
		notify,
		loadModels,
		switchModel,
		selectModel,
		runCommand,
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
