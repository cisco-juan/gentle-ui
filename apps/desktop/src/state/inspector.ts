import { createEffect, createSignal, untrack, type Accessor } from "solid-js";
import type {
	AgentCounts,
	AgentDetail,
	AgentTaskSummary,
	GitFileStatus,
	GitStatus,
	ServerMessage,
	WorkspaceTreeEntry,
} from "@gentle-shell/protocol";
import { agentOrder } from "../lib/agents.ts";
import type { BridgeClient } from "../lib/bridge";

/**
 * Inspector state.
 *
 * The panel is a thin view over this module: everything that can be reasoned about, or that will
 * need fixing, lives here as a plain function (task parsing, diff classification, breadcrumbs,
 * agent-activity projection) so it can be read without a browser. The bridge is only touched through
 * the four calls it already offers (`gitStatus`, `gitDiff`, `tree`, `readFile`), all of which are
 * workspace reads that belong to the bridge rather than to a thread.
 *
 * `Agents` renders the subagent activity the agent itself publishes. The bridge reads it from the
 * presence files gentle-pi writes and projects it; the `setWidget("gentle-agents", …)` line only says
 * that activity moved, so it triggers a re-read instead of being the list. Everything on this panel
 * belongs to the thread that is open: a switch resets it, and an answer read for another thread is
 * dropped rather than rendered.
 */

/** The minimal slice of the chat controller the inspector needs; `App.tsx` never leaks in here. */
export interface ChatControllerLike {
	readonly bridge: Accessor<BridgeClient | null>;
	/** Reactive, unlike `bridge`: the panels use it to tell "not asked yet" from "asked, nothing there". */
	readonly connection: Accessor<"connecting" | "connected" | "failed" | "disconnected">;
	readonly currentThread: Accessor<string | null>;
	/** Session file of the open thread; it changes on a switch, and every per-thread read is keyed by it. */
	readonly activePath: Accessor<string | null>;
	invoke<T>(command: string, params?: Record<string, unknown>): Promise<T>;
}

export type InspectorTab = "changes" | "files" | "tasks" | "agents";

export const INSPECTOR_TABS: readonly { readonly id: InspectorTab; readonly label: string }[] = [
	{ id: "changes", label: "Changes" },
	{ id: "files", label: "Files" },
	{ id: "tasks", label: "Tasks" },
	{ id: "agents", label: "Agents" },
];

/** Where ODD task lists live inside a workspace. */
export const TASKS_DIR = "odd/tasks";
/** Widget key gentle-pi uses for its RPC subagent activity line. */
export const AGENTS_WIDGET_KEY = "gentle-agents";

/** A diff longer than this is reported as truncated instead of rendering every line. */
export const MAX_DIFF_LINES = 3000;
/** A file longer than this is previewed, not dumped into the DOM. */
export const MAX_FILE_LINES = 2000;

const GLYPHS: Record<GitFileStatus, string> = {
	added: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
	untracked: "U",
};

export interface ChangesView {
	readonly status: GitStatus | null;
	readonly diff: { readonly path: string; readonly text: string } | null;
	readonly loading: boolean;
	readonly error: string | null;
}

export interface FilesView {
	/** Directory currently listed, workspace-relative; empty is the workspace root. */
	readonly path: string;
	readonly entries: readonly WorkspaceTreeEntry[];
	readonly file: { readonly path: string; readonly content: string; readonly truncated: boolean } | null;
	readonly loading: boolean;
	readonly error: string | null;
}

export interface TaskItem {
	/** Leading identifier such as `T6` when the line has one. */
	readonly id: string | null;
	readonly text: string;
	readonly done: boolean;
}

export interface TaskFile {
	/** Feature name: the file name without `.md`. */
	readonly feature: string;
	readonly path: string;
	readonly tasks: readonly TaskItem[];
	readonly done: number;
	readonly total: number;
}

export interface TasksView {
	readonly files: readonly TaskFile[];
	readonly loading: boolean;
	readonly error: string | null;
}

/** What the Agents tab lists: the counters the agent published and every run, newest first. */
export interface AgentsView {
	readonly counts: AgentCounts;
	readonly tasks: readonly AgentTaskSummary[];
	readonly loading: boolean;
	readonly error: string | null;
}

/** The one run whose modal is open, with the row it was opened from for its header. */
export interface AgentDetailView {
	readonly taskId: string;
	readonly summary: AgentTaskSummary | null;
	readonly data: AgentDetail | null;
	readonly loading: boolean;
	readonly error: string | null;
}

export interface DiffLine {
	readonly kind: "add" | "remove" | "hunk" | "meta" | "context";
	readonly text: string;
}

export interface InspectorState {
	readonly tab: Accessor<InspectorTab>;
	readonly connected: Accessor<boolean>;
	readonly changes: Accessor<ChangesView>;
	readonly files: Accessor<FilesView>;
	readonly tasks: Accessor<TasksView>;
	readonly agents: Accessor<AgentsView>;
	/** The run whose modal is open, or null when the modal is closed. */
	readonly agentDetail: Accessor<AgentDetailView | null>;
	select(tab: InspectorTab): void;
	/** Reload whatever the active tab shows. */
	refresh(): Promise<void>;
	refreshChanges(): Promise<void>;
	openDiff(path: string): Promise<void>;
	openDir(path: string): Promise<void>;
	openFile(path: string): Promise<void>;
	openParent(): Promise<void>;
	loadTasks(): Promise<void>;
	/** Re-read the open thread's subagent activity: when the tab opens and on every widget update. */
	loadAgents(): Promise<void>;
	/** Open one run's iteration in the modal. */
	openAgent(taskId: string): Promise<void>;
	closeAgent(): void;
	stop(): void;
}

const EMPTY_CHANGES: ChangesView = { status: null, diff: null, loading: false, error: null };
const EMPTY_FILES: FilesView = { path: "", entries: [], file: null, loading: false, error: null };
const EMPTY_TASKS: TasksView = { files: [], loading: false, error: null };
const ZERO_COUNTS: AgentCounts = { running: 0, queued: 0, waiting: 0, finished: 0 };
const EMPTY_AGENTS: AgentsView = { counts: ZERO_COUNTS, tasks: [], loading: false, error: null };

/** What has been read for one session, and the run whose modal is open inside it. */
interface AgentState {
	/** Session path this answer belongs to; null when nothing has been read yet. */
	readonly sessionPath: string | null;
	readonly counts: AgentCounts;
	readonly tasks: readonly AgentTaskSummary[];
	readonly loading: boolean;
	readonly error: string | null;
	readonly detail: AgentDetailState | null;
}

interface AgentDetailState {
	readonly sessionPath: string | null;
	readonly taskId: string;
	/** The row that was clicked: the detail answer carries no model or timestamps of its own. */
	readonly summary: AgentTaskSummary | null;
	readonly data: AgentDetail | null;
	readonly loading: boolean;
	readonly error: string | null;
}

const EMPTY_AGENT_STATE: AgentState = { sessionPath: null, counts: ZERO_COUNTS, tasks: [], loading: false, error: null, detail: null };

/** Create the inspector. Call it from a component so the bridge effect has an owner. */
export function createInspector(options: {
	readonly connect: () => BridgeClient | null;
	/** Session file of the open thread; a change resets everything that belongs to a thread. */
	readonly activePath: () => string | null;
}): InspectorState {
	const [tab, setTab] = createSignal<InspectorTab>("changes");
	const [connected, setConnected] = createSignal(false);
	const [changes, setChanges] = createSignal<ChangesView>(EMPTY_CHANGES);
	const [files, setFiles] = createSignal<FilesView>(EMPTY_FILES);
	const [tasks, setTasks] = createSignal<TasksView>(EMPTY_TASKS);
	const [agentState, setAgentState] = createSignal<AgentState>(EMPTY_AGENT_STATE);

	// Each view carries a generation so a slow answer cannot overwrite a newer one.
	let changesRun = 0;
	let filesRun = 0;
	let tasksRun = 0;
	let agentsRun = 0;
	let detailRun = 0;
	/** The widget line the last read was triggered by, so an unchanged line does not re-read the files. */
	let lastWidget = "";
	let unsubscribe: (() => void) | null = null;
	let bound: BridgeClient | null = null;
	let retries = 0;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;

	// `chat.bridge()` is a plain closure today, not a signal, so the effect may only ever see `null`.
	// Every load retries the binding and this bounded probe covers the window before the bridge
	// connects, so the panel starts working without asking the user to click a tab first.
	createEffect(() => {
		const client = options.connect();
		if (client === null) {
			if (bound === null) probeForBridge();
			return;
		}
		if (client === bound) return;
		bind(client);
		// A transport that just appeared should fill the tab the panel is already showing.
		void untrack(loadActive);
	});

	// The panel is one component that every thread reuses, and subagent activity belongs to the thread
	// whose session file is open. A switch therefore clears the tab, closes the modal, and bumps both
	// generations so an answer still in flight for the old thread is dropped when it lands.
	createEffect(() => {
		void options.activePath();
		untrack(resetAgents);
	});

	function probeForBridge(): void {
		if (retryTimer !== null || retries >= 40) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			retries += 1;
			const client = options.connect();
			if (client === null) {
				probeForBridge();
				return;
			}
			bind(client);
			void untrack(loadActive);
		}, 250);
	}

	function bind(client: BridgeClient | null): void {
		if (client === bound) return;
		unsubscribe?.();
		unsubscribe = null;
		bound = client;
		setConnected(client !== null);
		if (client === null) return;
		unsubscribe = client.subscribe(handleMessage);
	}

	function handleMessage(message: ServerMessage): void {
		if (message.kind !== "record") return;
		const record = message.record;
		if (record.type !== "extension_ui_request" || record.method !== "setWidget") return;
		if (record.widgetKey !== AGENTS_WIDGET_KEY) return;
		// The widget line is the trigger, not the list: it says the agent's activity moved, and the tab
		// re-reads what the bridge projects from the presence files. An unchanged line is not a new reason.
		const lines = record.widgetLines;
		const text = Array.isArray(lines) ? lines.filter((line): line is string => typeof line === "string").join("\n") : "";
		if (text === lastWidget) return;
		lastWidget = text;
		void loadAgents();
	}

	/** What the tab shows: nothing that was read for another session, whatever is in the signal. */
	function agentView(): AgentsView {
		const state = agentState();
		if (state.sessionPath !== options.activePath()) return EMPTY_AGENTS;
		return { counts: state.counts, tasks: state.tasks, loading: state.loading, error: state.error };
	}

	/** The open run, or null once the thread it belonged to is no longer the open one. */
	function agentDetailView(): AgentDetailView | null {
		const detail = agentState().detail;
		if (detail === null || detail.sessionPath !== options.activePath()) return null;
		return { taskId: detail.taskId, summary: detail.summary, data: detail.data, loading: detail.loading, error: detail.error };
	}

	function resetAgents(): void {
		agentsRun += 1;
		detailRun += 1;
		lastWidget = "";
		setAgentState(EMPTY_AGENT_STATE);
	}

	/**
	 * The read state for `path`. A read that starts for a different thread inherits nothing from the
	 * previous one — not the rows, not the counters, not an open modal — so a switch never shows the
	 * previous chat's activity, not even for the moment a read is in flight.
	 */
	function agentStateFor(current: AgentState, path: string | null): AgentState {
		return current.sessionPath === path ? current : { ...EMPTY_AGENT_STATE, sessionPath: path };
	}

	async function loadAgents(): Promise<void> {
		const client = options.connect();
		bind(client);
		const path = options.activePath();
		const run = ++agentsRun;
		if (client === null) {
			setAgentState({ ...EMPTY_AGENT_STATE, sessionPath: path, error: "the bridge is not connected" });
			return;
		}

		setAgentState((current) => ({ ...agentStateFor(current, path), loading: true, error: null }));
		try {
			const list = await client.agents({ action: "list", ...(path === null ? {} : { sessionPath: path }) });
			if (run !== agentsRun || path !== options.activePath()) return;
			setAgentState((current) => ({
				...agentStateFor(current, path),
				counts: list.counts,
				tasks: agentOrder(list.tasks),
				loading: false,
				error: null,
			}));
		} catch (error) {
			if (run !== agentsRun || path !== options.activePath()) return;
			setAgentState((current) => ({ ...agentStateFor(current, path), loading: false, error: messageOf(error) }));
		}
	}

	async function openAgent(taskId: string): Promise<void> {
		const client = options.connect();
		bind(client);
		const path = options.activePath();
		// The row is what the modal's header describes; the detail answer is only the iteration.
		const summary = untrack(agentView).tasks.find((task) => task.id === taskId) ?? null;
		const run = ++detailRun;
		const starting: AgentDetailState = { sessionPath: path, taskId, summary, data: null, loading: true, error: null };
		setAgentState((current) => ({ ...current, detail: starting }));

		if (client === null) {
			setAgentState((current) => settleDetail(current, taskId, { loading: false, error: "the bridge is not connected" }));
			return;
		}

		try {
			const data = await client.agents({ action: "detail", taskId, ...(path === null ? {} : { sessionPath: path }) });
			if (run !== detailRun || path !== options.activePath()) return;
			setAgentState((current) => settleDetail(current, taskId, { data, loading: false }));
		} catch (error) {
			if (run !== detailRun || path !== options.activePath()) return;
			setAgentState((current) => settleDetail(current, taskId, { loading: false, error: messageOf(error) }));
		}
	}

	function closeAgent(): void {
		// The answer may still be on its way; bumping the generation makes it land nowhere.
		detailRun += 1;
		setAgentState((current) => (current.detail === null ? current : { ...current, detail: null }));
	}

	function select(next: InspectorTab): void {
		setTab(next);
		void loadActive();
	}

	/** Load whichever tab is visible; used by the panel, the refresh button and the bridge effect. */
	function loadActive(): Promise<void> {
		if (tab() === "changes") return refreshChanges();
		if (tab() === "files") return openDir(files().path);
		if (tab() === "tasks") return loadTasks();
		if (tab() === "agents") return loadAgents();
		return Promise.resolve();
	}

	async function refreshChanges(): Promise<void> {
		const client = options.connect();
		const run = ++changesRun;
		bind(client);
		if (client === null) {
			setChanges((current) => ({ ...current, loading: false, error: "the bridge is not connected" }));
			return;
		}

		setChanges((current) => ({ ...current, loading: true, error: null }));
		try {
			const status = await client.gitStatus();
			if (run !== changesRun) return;
			setChanges((current) => ({
				...current,
				status,
				loading: false,
			}));
		} catch (error) {
			if (run !== changesRun) return;
			setChanges((current) => ({ ...current, loading: false, error: messageOf(error) }));
			return;
		}

		const selected = untrack(() => changes().diff?.path);
		if (selected !== undefined) await openDiff(selected);
	}

	async function openDiff(path: string): Promise<void> {
		const client = options.connect();
		bind(client);
		if (client === null) {
			setChanges((current) => ({ ...current, error: "the bridge is not connected" }));
			return;
		}

		const run = ++changesRun;
		setChanges((current) => ({ ...current, loading: true, error: null }));
		try {
			const text = await client.gitDiff(path);
			if (run !== changesRun) return;
			setChanges((current) => ({ ...current, loading: false, diff: { path, text } }));
		} catch (error) {
			if (run !== changesRun) return;
			setChanges((current) => ({ ...current, loading: false, diff: null, error: messageOf(error) }));
		}
	}

	async function openDir(path: string): Promise<void> {
		const client = options.connect();
		const run = ++filesRun;
		bind(client);
		if (client === null) {
			setFiles((current) => ({ ...current, loading: false, error: "the bridge is not connected" }));
			return;
		}

		setFiles((current) => ({ ...current, loading: true, error: null }));
		try {
			const entries = await client.tree(path);
			if (run !== filesRun) return;
			setFiles({ path, entries, file: null, loading: false, error: null });
		} catch (error) {
			if (run !== filesRun) return;
			setFiles((current) => ({ ...current, loading: false, error: messageOf(error) }));
		}
	}

	async function openFile(path: string): Promise<void> {
		const client = options.connect();
		bind(client);
		if (client === null) {
			setFiles((current) => ({ ...current, error: "the bridge is not connected" }));
			return;
		}

		const run = ++filesRun;
		setFiles((current) => ({ ...current, loading: true, error: null }));
		try {
			const read = await client.readFile(path);
			if (run !== filesRun) return;
			setFiles((current) => ({
				...current,
				loading: false,
				file: { path, content: read.content, truncated: read.truncated },
			}));
		} catch (error) {
			if (run !== filesRun) return;
			setFiles((current) => ({ ...current, loading: false, file: null, error: messageOf(error) }));
		}
	}

	async function openParent(): Promise<void> {
		const current = untrack(() => files());
		// Stepping out of a preview returns to the listing before walking up a directory.
		if (current.file !== null) {
			setFiles((value) => ({ ...value, file: null }));
			return;
		}
		await openDir(parentPath(current.path));
	}

	async function loadTasks(): Promise<void> {
		const client = options.connect();
		const run = ++tasksRun;
		bind(client);
		if (client === null) {
			setTasks({ files: [], loading: false, error: "the bridge is not connected" });
			return;
		}

		setTasks((current) => ({ ...current, loading: true, error: null }));
		let entries: readonly WorkspaceTreeEntry[];
		try {
			entries = await client.tree(TASKS_DIR);
		} catch (error) {
			if (run !== tasksRun) return;
			setTasks({ files: [], loading: false, error: messageOf(error) });
			return;
		}

		const parsed: TaskFile[] = [];
		for (const entry of taskFiles(entries)) {
			try {
				const read = await client.readFile(entry.path);
				parsed.push(parseTasks(read.content, entry.path));
			} catch {
				// A task file that cannot be read is left out instead of breaking the tab.
			}
		}
		if (run !== tasksRun) return;
		setTasks({ files: parsed, loading: false, error: null });
	}

	function refresh(): Promise<void> {
		return loadActive();
	}

	function stop(): void {
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
		unsubscribe?.();
		unsubscribe = null;
		bound = null;
	}

	return {
		tab,
		connected,
		changes,
		files,
		tasks,
		agents: agentView,
		agentDetail: agentDetailView,
		select,
		refresh,
		refreshChanges,
		openDiff,
		openDir,
		openFile,
		openParent,
		loadTasks,
		loadAgents,
		openAgent,
		closeAgent,
		stop,
	};
}

/** The `.md` files of `odd/tasks`, sorted by name. */
export function taskFiles(entries: readonly WorkspaceTreeEntry[]): readonly WorkspaceTreeEntry[] {
	return entries
		.filter((entry) => entry.kind === "file" && entry.name.endsWith(".md"))
		.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * Read one ODD task list.
 *
 * The format is `T6  [x] Right inspector tabs…` under an `## Tasks` heading, with plain `- [ ]`
 * checkboxes in newer lists, so the matcher accepts an optional bullet or heading marker and an
 * optional leading identifier instead of pinning one dialect.
 */
export function parseTasks(markdown: string, path: string): TaskFile {
	const tasks: TaskItem[] = [];
	for (const line of tasksSection(markdown)) {
		const match = /^\s*(?:[#>*+-]\s*)*(?:([A-Za-z][\w.-]*)\s+)?\[\s*([xX ])\s*\]\s*(.+?)\s*$/.exec(line);
		if (match === null) continue;
		const id = match[1] ?? null;
		const text = match[3] ?? "";
		if (text.length === 0) continue;
		tasks.push({ id, text, done: (match[2] ?? " ").trim().length > 0 });
	}

	return {
		feature: featureOf(path),
		path,
		tasks,
		done: tasks.filter((task) => task.done).length,
		total: tasks.length,
	};
}

/** File name without `.md`, which is what the ODD doc calls the feature. */
export function featureOf(path: string): string {
	const name = path.split("/").pop() ?? path;
	return name.replace(/\.md$/, "");
}

/**
 * The `## Tasks` section when the file has one, else the whole document.
 *
 * Restricting the scan keeps prose, log entries and quotes that mention a checkbox from being
 * counted as tasks.
 */
function tasksSection(markdown: string): readonly string[] {
	const lines = markdown.split("\n");
	const start = lines.findIndex((line) => /^#{1,6}\s+tasks\s*$/i.test(line));
	if (start === -1) return lines;

	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^#{1,6}\s+\S/.test(line));
	return end === -1 ? rest : rest.slice(0, end);
}

/** Classify unified diff lines for rendering; the `+`/`-` marker itself is stripped. */
export function diffLines(text: string, limit = MAX_DIFF_LINES): { lines: DiffLine[]; truncated: boolean } {
	const all = text.split("\n");
	if (all[all.length - 1] === "") all.pop();
	return {
		lines: all.slice(0, limit).map(classifyDiffLine),
		truncated: all.length > limit,
	};
}

function classifyDiffLine(line: string): DiffLine {
	if (
		line.startsWith("diff ") ||
		line.startsWith("index ") ||
		line.startsWith("+++") ||
		line.startsWith("---") ||
		line.startsWith("new file") ||
		line.startsWith("deleted file") ||
		line.startsWith("old mode") ||
		line.startsWith("new mode") ||
		line.startsWith("similarity") ||
		line.startsWith("rename ") ||
		line.startsWith("\\ No newline")
	) {
		return { kind: "meta", text: line };
	}
	if (line.startsWith("@@")) return { kind: "hunk", text: line };
	if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
	if (line.startsWith("-")) return { kind: "remove", text: line.slice(1) };
	return { kind: "context", text: line.startsWith(" ") ? line.slice(1) : line };
}

/** Split a file preview into lines and say whether the render cap hid the tail. */
export function clipLines(text: string, limit = MAX_FILE_LINES): { lines: string[]; truncated: boolean } {
	const all = text.split("\n");
	if (all[all.length - 1] === "") all.pop();
	return { lines: all.slice(0, limit), truncated: all.length > limit };
}

export function statusGlyph(status: GitFileStatus): string {
	return GLYPHS[status];
}

/** Parent directory of a workspace-relative path; the workspace root for a top-level entry. */
export function parentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index <= 0 ? "" : path.slice(0, index);
}

/** Breadcrumb from the workspace root down to `path`, each step carrying the path it opens. */
export function breadcrumb(path: string): readonly { readonly label: string; readonly path: string }[] {
	const crumbs: Array<{ label: string; path: string }> = [{ label: "workspace", path: "" }];
	let current = "";
	for (const part of path.split("/")) {
		if (part.length === 0) continue;
		current = current.length === 0 ? part : `${current}/${part}`;
		crumbs.push({ label: part, path: current });
	}
	return crumbs;
}

/** Apply an answer to the modal only while it is still the run that is open. */
function settleDetail(
	state: AgentState,
	taskId: string,
	patch: { readonly loading: boolean; readonly data?: AgentDetail; readonly error?: string },
): AgentState {
	const detail = state.detail;
	if (detail === null || detail.taskId !== taskId) return state;
	return { ...state, detail: { ...detail, ...patch } };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
