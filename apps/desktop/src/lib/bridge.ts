import type {
	AgentDetail,
	AgentList,
	ClientMessage,
	ExtensionUiResponse,
	GitStatus,
	HistoryPage,
	MemoryContextView,
	MemoryProjectsView,
	MemorySearchView,
	PermissionsView,
	ProfileMode,
	ProfileRoute,
	ProfilesActivation,
	ProfilesView,
	ReviewAssessment,
	ReviewMode,
	ReviewStartView,
	ReviewStatusView,
	ServerMessage,
	SessionSummary,
	WorkspaceFileContent,
	WorkspaceTreeEntry,
} from "@gentle-shell/protocol";

type Listener = (message: ServerMessage) => void;
type CloseListener = () => void;

/** What the Review panel can ask the bridge for; each action answers with its own shape. */
export type ReviewRequest =
	| { readonly action: "status" }
	| { readonly action: "assess" }
	| { readonly action: "mode" }
	| { readonly action: "start"; readonly tokens: readonly string[] }
	| { readonly action: "consent"; readonly invocation: string };

export type ReviewAnswer = ReviewStatusView | ReviewAssessment | ReviewMode | ReviewStartView;

/** What the Memory panel can ask for. Every one of these reads; none of them writes. */
export type MemoryRequest =
	| { readonly action: "context" }
	| { readonly action: "search"; readonly query: string; readonly limit?: number }
	| { readonly action: "projects" };

export type MemoryAnswer = MemoryContextView | MemorySearchView | MemoryProjectsView;

/** What the Profiles sheet can ask for. Every change answers with the whole list as it now is on disk. */
export type ProfilesRequest =
	| { readonly action: "list" }
	| { readonly action: "save"; readonly name: string; readonly routes: readonly ProfileRoute[]; readonly mode: ProfileMode }
	| { readonly action: "create"; readonly name: string; readonly from?: string }
	| { readonly action: "rename"; readonly name: string; readonly to: string }
	| { readonly action: "delete"; readonly name: string }
	| { readonly action: "activate"; readonly name: string };

export type ProfilesAnswer = ProfilesView | ProfilesActivation;

/** What the Agents tab asks for: the list for a thread, then one run's iteration. */
export type AgentsRequest =
	| { readonly action: "list"; readonly sessionPath?: string }
	| { readonly action: "detail"; readonly sessionPath?: string; readonly taskId: string };

export type AgentsAnswer = AgentList | AgentDetail;

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

export class BridgeClient {
	#socket: WebSocket | null = null;
	#listeners = new Set<Listener>();
	#closeListeners = new Set<CloseListener>();
	/** Set while `close()` runs, so a close the caller asked for is not reported as a loss. */
	#closing = false;
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
				const lost = this.#socket === socket && !this.#closing;
				if (this.#socket === socket) this.#socket = null;
				for (const [, pending] of this.#pending) pending.reject(new Error("bridge connection closed"));
				this.#pending.clear();
				if (lost) for (const listener of [...this.#closeListeners]) listener();
			});
		});
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Called once when the connection ends without `close()` having been asked for. */
	onClose(listener: CloseListener): () => void {
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
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

	/** Ask the bridge for its session index, newest first. */
	sessions(): Promise<readonly SessionSummary[]> {
		const id = this.#nextId();
		return this.#request<readonly SessionSummary[]>({ kind: "sessions", id });
	}

	/**
	 * One page of a session file's transcript, newest first.
	 *
	 * `before` is the cursor the previous page returned; leaving it out reads the newest page. The bridge
	 * only reads files under the session directory it lists, so a path from anywhere else is refused.
	 */
	history(request: {
		readonly sessionPath: string;
		readonly before?: number;
		readonly limit?: number;
	}): Promise<HistoryPage> {
		const id = this.#nextId();
		return this.#request<HistoryPage>({
			kind: "history",
			id,
			action: "page",
			sessionPath: request.sessionPath,
			...(request.before === undefined ? {} : { before: request.before }),
			...(request.limit === undefined ? {} : { limit: request.limit }),
		});
	}

	/** Branch and per-file changes of the bridge's workspace. Not thread-scoped. */
	gitStatus(): Promise<GitStatus> {
		const id = this.#nextId();
		return this.#request<GitStatus>({ kind: "git", id, action: "status" });
	}

	/** Unified diff for one workspace-relative path; an untracked file arrives as all-added. */
	gitDiff(path: string): Promise<string> {
		const id = this.#nextId();
		return this.#request<string>({ kind: "git", id, action: "diff", path });
	}

	/** One directory of the workspace, directories first. `path` is workspace-relative. */
	tree(path = ""): Promise<readonly WorkspaceTreeEntry[]> {
		const id = this.#nextId();
		return this.#request<readonly WorkspaceTreeEntry[]>({ kind: "fs", id, action: "tree", path });
	}

	/** Read a workspace file, capped by the bridge; `truncated` says the cap was hit. */
	readFile(path: string): Promise<WorkspaceFileContent> {
		const id = this.#nextId();
		return this.#request<WorkspaceFileContent>({ kind: "fs", id, action: "read", path });
	}

	/**
	 * Native review. One method for the whole family, typed per action, so no component opens a raw
	 * socket or builds a provider command line of its own.
	 */
	review(request: { readonly action: "status" }): Promise<ReviewStatusView>;
	review(request: { readonly action: "assess" }): Promise<ReviewAssessment>;
	review(request: { readonly action: "mode" }): Promise<ReviewMode>;
	review(request: { readonly action: "start"; readonly tokens: readonly string[] }): Promise<ReviewStartView>;
	review(request: { readonly action: "consent"; readonly invocation: string }): Promise<ReviewStartView>;
	review(request: ReviewRequest): Promise<ReviewAnswer> {
		const id = this.#nextId();
		if (request.action === "start") {
			return this.#request<ReviewStartView>({ kind: "review", id, action: "start", tokens: request.tokens });
		}
		if (request.action === "consent") {
			return this.#request<ReviewStartView>({ kind: "review", id, action: "consent", invocation: request.invocation });
		}
		return this.#request<ReviewAnswer>({ kind: "review", id, action: request.action });
	}

	/**
	 * Engram's memory for the bridge's workspace. One method for the whole family, typed per action,
	 * so no component opens a raw socket and no component can ask for a write: the wire has no such
	 * message.
	 */
	memory(request: { readonly action: "context" }): Promise<MemoryContextView>;
	memory(request: {
		readonly action: "search";
		readonly query: string;
		readonly limit?: number;
	}): Promise<MemorySearchView>;
	memory(request: { readonly action: "projects" }): Promise<MemoryProjectsView>;
	memory(request: MemoryRequest): Promise<MemoryAnswer> {
		const id = this.#nextId();
		if (request.action === "search") {
			return this.#request<MemorySearchView>({
				kind: "memory",
				id,
				action: "search",
				query: request.query,
				...(request.limit === undefined ? {} : { limit: request.limit }),
			});
		}
		return this.#request<MemoryAnswer>({ kind: "memory", id, action: request.action });
	}

	/** The default permission mode for new threads. The bridge refuses anything but a lowering. */
	permissions(request: { readonly action: "status" } | { readonly action: "default"; readonly mode: string }): Promise<PermissionsView> {
		const id = this.#nextId();
		return this.#request<PermissionsView>({ kind: "permissions", id, ...request });
	}

	/**
	 * Gentle Shell's profiles file, read and written by the bridge with gentle-pi's own library. A change
	 * the bridge refuses (a duplicate name, deleting the default) rejects with its message.
	 */
	profiles(request: { readonly action: "activate"; readonly name: string }): Promise<ProfilesActivation>;
	profiles(request: Exclude<ProfilesRequest, { readonly action: "activate" }>): Promise<ProfilesView>;
	profiles(request: ProfilesRequest): Promise<ProfilesAnswer> {
		const id = this.#nextId();
		return this.#request<ProfilesAnswer>({ kind: "profiles", id, ...request });
	}

	/**
	 * Subagent activity of the thread whose session file is `sessionPath`. One method for the family, typed
	 * per action, so the tab never builds a wire message of its own.
	 */
	agents(request: { readonly action: "list"; readonly sessionPath?: string }): Promise<AgentList>;
	agents(request: { readonly action: "detail"; readonly sessionPath?: string; readonly taskId: string }): Promise<AgentDetail>;
	agents(request: AgentsRequest): Promise<AgentsAnswer> {
		const id = this.#nextId();
		if (request.action === "detail") {
			return this.#request<AgentDetail>({
				kind: "agents",
				id,
				action: "detail",
				taskId: request.taskId,
				...(request.sessionPath === undefined ? {} : { sessionPath: request.sessionPath }),
			});
		}
		return this.#request<AgentList>({
			kind: "agents",
			id,
			action: "list",
			...(request.sessionPath === undefined ? {} : { sessionPath: request.sessionPath }),
		});
	}

	close(): void {
		this.#closing = true;
		try {
			this.#socket?.close();
		} finally {
			this.#socket = null;
			this.#closing = false;
		}
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
		if (message.kind === "sessions") {
			this.#settle(message.id, message.items);
			return;
		}
		if (message.kind === "history") {
			this.#settle(message.id, message.data);
			return;
		}
		if (message.kind === "git" || message.kind === "fs") {
			this.#settle(message.id, message.data);
			return;
		}
		if (message.kind === "review") {
			this.#settle(message.id, message.data);
			return;
		}
		if (message.kind === "memory") {
			this.#settle(message.id, message.data);
			return;
		}
		if (message.kind === "profiles" || message.kind === "permissions") {
			this.#settle(message.id, message.data);
			return;
		}
		if (message.kind === "agents") {
			this.#settle(message.id, message.data);
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
