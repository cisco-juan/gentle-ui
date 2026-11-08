import { For, Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import "../inspector.css";
import {
	INSPECTOR_TABS,
	breadcrumb,
	clipLines,
	createInspector,
	diffLines,
	statusGlyph,
	type ChatControllerLike,
	type InspectorState,
	type InspectorTab,
} from "../state/inspector";
import { REVIEW_TAB, createReviewPanel } from "../state/review";
import { MEMORY_TAB, createMemoryPanel } from "../state/memory";
import { ReviewTab } from "./ReviewTab";
import { MemoryTab } from "./MemoryTab";
import { SkeletonLines } from "./Skeleton";

/** Tabs that own their state and their scroller instead of reusing the inspector's four reads. */
type OwnedTab = "review" | "memory";

/**
 * Right-hand inspector.
 *
 * Four tabs over workspace reads the bridge already performs: git changes with an inline diff, a file
 * tree with a read-only preview, the ODD task lists, and the subagent activity the agent publishes.
 * Review (native review, RDD) and Memory (Engram, read-only) each own their state module and their
 * scroller. The panel owns no shell state — it is mounted into the parent's grid and only speaks to
 * the bridge through the chat controller it is given.
 */
export function Inspector(props: { chat: ChatControllerLike; onClose?: () => void }): JSX.Element {
	const inspector = createInspector({ connect: () => props.chat.bridge() });
	const review = createReviewPanel({ connect: () => props.chat.bridge() });
	const memory = createMemoryPanel({ connect: () => props.chat.bridge() });
	// Review and Memory keep their own switch instead of widening the inspector's tab union: the other
	// four tabs do not know they exist, and their state stays exactly as it was.
	const [ownedTab, setOwnedTab] = createSignal<OwnedTab | null>(null);
	onCleanup(() => {
		inspector.stop();
		review.stop();
		memory.stop();
	});

	function openTab(id: InspectorTab | OwnedTab): void {
		if (id !== "review" && id !== "memory") {
			setOwnedTab(null);
			inspector.select(id);
			return;
		}
		setOwnedTab(id);
		if (id === "review") void review.refresh();
		else void memory.refresh();
	}

	// True while the tab strip has more tabs past its right edge, so the fade only shows when it is true.
	const [moreTabs, setMoreTabs] = createSignal(false);
	let tabStrip: HTMLDivElement | undefined;

	function measureTabs(): void {
		if (!tabStrip) return;
		setMoreTabs(tabStrip.scrollLeft + tabStrip.clientWidth < tabStrip.scrollWidth - 1);
	}

	/** False until the agent is connected: before that nothing has been read, so no tab has anything true to say. */
	const ready = (): boolean => props.chat.connection() !== "connecting";

	function activeTab(id: InspectorTab | OwnedTab): boolean {
		const owned = ownedTab();
		if (id === "review" || id === "memory") return owned === id;
		return owned === null && inspector.tab() === id;
	}

	return (
		<aside class="inspector" aria-label="Inspector">
			<header class="inspector-head">
				<div
					class={`inspector-tabs${moreTabs() ? " more" : ""}`}
					role="tablist"
					aria-label="Inspector tabs"
					onScroll={measureTabs}
					ref={(element) => {
						tabStrip = element;
						// The panel is resized by dragging, so the overflow has to be re-read as its width changes.
						const observer = new ResizeObserver(measureTabs);
						observer.observe(element);
						onCleanup(() => observer.disconnect());
					}}
				>
					<For each={[...INSPECTOR_TABS, REVIEW_TAB, MEMORY_TAB]}>
						{(entry) => (
							<button
								type="button"
								role="tab"
								class={`inspector-tab${activeTab(entry.id) ? " on" : ""}`}
								aria-selected={activeTab(entry.id)}
								onClick={(event) => {
									openTab(entry.id);
									// A tab clipped by the edge has to come into view when it is chosen.
									event.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest" });
								}}
							>
								{entry.label}
							</button>
						)}
					</For>
				</div>
				<Show when={props.onClose}>
					{(close) => (
						<button type="button" class="inspector-close" aria-label="Close inspector" onClick={() => close()()}>
							×
						</button>
					)}
				</Show>
			</header>

			<div
				class="inspector-body"
				classList={{ "for-review": ownedTab() === "review", "for-memory": ownedTab() === "memory" }}
			>
				{/* Until the agent is connected nothing has been read: a skeleton, not four empty-looking panels. */}
				<Show when={!ready()}>
					<SkeletonLines count={6} label="Waiting for the agent" />
				</Show>
				<Show when={ready() && ownedTab() === "review"}>
					<ReviewTab review={review} />
				</Show>
				<Show when={ready() && ownedTab() === "memory"}>
					<MemoryTab memory={memory} />
				</Show>
				<Show when={ready() && ownedTab() === null && inspector.tab() === "changes"}>
					<ChangesTab inspector={inspector} />
				</Show>
				<Show when={ready() && ownedTab() === null && inspector.tab() === "files"}>
					<FilesTab inspector={inspector} />
				</Show>
				<Show when={ready() && ownedTab() === null && inspector.tab() === "tasks"}>
					<TasksTab inspector={inspector} />
				</Show>
				<Show when={ready() && ownedTab() === null && inspector.tab() === "agents"}>
					<AgentsTab inspector={inspector} />
				</Show>
			</div>
		</aside>
	);
}

type Inspector = InspectorState;

function ChangesTab(props: { inspector: Inspector }): JSX.Element {
	const view = () => props.inspector.changes();
	const files = () => view().status?.files ?? [];
	const summary = createMemo(() => {
		const status = view().status;
		if (status === null || !status.isRepo) return "";
		const count = status.files.length;
		return `${status.branch || "detached"} · ${count === 1 ? "1 change" : `${count} changes`}`;
	});

	return (
		<>
			<div class="inspector-toolbar">
				<span class="inspector-note">{summary()}</span>
				<button
					type="button"
					class="inspector-action"
					disabled={view().loading}
					onClick={() => void props.inspector.refreshChanges()}
				>
					{view().loading ? "reading…" : "refresh"}
				</button>
			</div>

			<Show when={view().error}>{(error) => <p class="inspector-error">{error()}</p>}</Show>
			<Show when={view().loading && view().status === null}>
				<SkeletonLines count={5} label="Reading the working tree" />
			</Show>
			<Show when={view().status?.isRepo === false && view().error === null}>
				<p class="inspector-empty">This workspace is not a git repository.</p>
			</Show>
			<Show when={view().status?.isRepo === true && files().length === 0 && view().error === null}>
				<p class="inspector-empty">Working tree clean.</p>
			</Show>

			<ul class="inspector-list">
				<For each={files()}>
					{(file) => (
						<li>
							<button
								type="button"
								class={`change${view().diff?.path === file.path ? " on" : ""}`}
								onClick={() => void props.inspector.openDiff(file.path)}
							>
								<span class={`glyph ${file.status}`}>{statusGlyph(file.status)}</span>
								<span class="path">{file.path}</span>
								<Show when={file.additions !== undefined}>
									<span class="counts">
										<em class="plus">+{file.additions}</em> <em class="minus">−{file.deletions}</em>
									</span>
								</Show>
								<Show when={file.staged}>
									<span class="tag-stage">staged</span>
								</Show>
							</button>
						</li>
					)}
				</For>
			</ul>

			<Show when={view().diff}>
				{(diff) => {
					const rendered = createMemo(() => diffLines(diff().text));
					return (
						<section class="inspector-diff">
							<div class="inspector-toolbar">
								<span class="inspector-note mono">{diff().path}</span>
							</div>
							<Show
								when={rendered().lines.length > 0}
								fallback={<p class="inspector-empty">No textual changes for this path.</p>}
							>
								<pre class="diff">
									<For each={rendered().lines}>
										{(line) => (
											<span class={`line ${line.kind}`}>
												{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : line.kind === "context" ? " " : ""}
												{line.text}
												{"\n"}
											</span>
										)}
									</For>
								</pre>
							</Show>
							<Show when={rendered().truncated}>
								<p class="inspector-note">Diff truncated at 3000 lines.</p>
							</Show>
						</section>
					);
				}}
			</Show>
		</>
	);
}

function FilesTab(props: { inspector: Inspector }): JSX.Element {
	const view = () => props.inspector.files();
	const preview = createMemo(() => (view().file === null ? null : clipLines(view().file?.content ?? "")));
	// The trail follows the preview, so a file's path is visible and every parent stays one click away.
	const trail = () => view().file?.path ?? view().path;

	return (
		<>
			<div class="inspector-toolbar">
				<nav class="crumbs" aria-label="Workspace path">
					<For each={breadcrumb(trail())}>
						{(crumb, index) => (
							<>
								<Show when={index() > 0}>
									<span class="crumb-sep">/</span>
								</Show>
								<button type="button" class="crumb" onClick={() => void props.inspector.openDir(crumb.path)}>
									{crumb.label}
								</button>
							</>
						)}
					</For>
				</nav>
				<Show when={view().path.length > 0 || view().file !== null}>
					<button type="button" class="inspector-action" onClick={() => void props.inspector.openParent()}>
						{view().file !== null ? "close" : "up"}
					</button>
				</Show>
			</div>

			<Show when={view().error}>{(error) => <p class="inspector-error">{error()}</p>}</Show>

			<Show when={view().file}>
				{(file) => (
					<section class="inspector-preview">
						<div class="inspector-toolbar">
							<span class="inspector-note mono">{file().path}</span>
							<Show when={file().truncated}>
								<span class="tag-stage">truncated</span>
							</Show>
						</div>
						<pre class="file">
							<For each={preview()?.lines ?? []}>{(line) => <span class="line">{line}{"\n"}</span>}</For>
						</pre>
						<Show when={preview()?.truncated}>
							<p class="inspector-note">Previewing the first 2000 lines.</p>
						</Show>
					</section>
				)}
			</Show>

			<ul class="inspector-list">
				<For each={view().entries}>
					{(entry) => (
						<li>
							<button
								type="button"
								class={`tree-entry ${entry.kind}`}
								onClick={() => void (entry.kind === "dir" ? props.inspector.openDir(entry.path) : props.inspector.openFile(entry.path))}
							>
								<span class="tree-mark">{entry.kind === "dir" ? "▸" : "·"}</span>
								<span class="path">{entry.name}</span>
							</button>
						</li>
					)}
				</For>
			</ul>

			<Show when={view().loading && view().entries.length === 0}>
				<SkeletonLines count={6} label="Reading the directory" />
			</Show>
			<Show when={!view().loading && view().error === null && view().entries.length === 0}>
				<p class="inspector-empty">Empty directory.</p>
			</Show>
		</>
	);
}

function TasksTab(props: { inspector: Inspector }): JSX.Element {
	const view = () => props.inspector.tasks();

	return (
		<>
			<div class="inspector-toolbar">
				<span class="inspector-note">odd/tasks</span>
				<button type="button" class="inspector-action" disabled={view().loading} onClick={() => void props.inspector.loadTasks()}>
					{view().loading ? "reading…" : "refresh"}
				</button>
			</div>

			<Show when={view().error}>{(error) => <p class="inspector-error">{error()}</p>}</Show>
			<Show when={view().loading && view().files.length === 0}>
				<SkeletonLines count={4} label="Reading the task lists" />
			</Show>
			<Show when={!view().loading && view().error === null && view().files.length === 0}>
				<p class="inspector-empty">No task lists in odd/tasks.</p>
			</Show>

			<For each={view().files}>
				{(file) => (
					<section class="task-file">
						<header>
							<span class="task-feature">{file.feature}</span>
							<span class="task-progress">
								{file.done}/{file.total}
							</span>
						</header>
						<ul class="task-list">
							<For each={file.tasks}>
								{(task) => (
									<li classList={{ done: task.done }}>
										<span class="task-box">{task.done ? "▣" : "▢"}</span>
										<Show when={task.id}>{(id) => <span class="task-id">{id()}</span>}</Show>
										<span class="task-text">{task.text}</span>
									</li>
								)}
							</For>
						</ul>
						<Show when={file.total === 0}>
							<p class="inspector-note">{file.feature} has no checklist lines.</p>
						</Show>
					</section>
				)}
			</For>
		</>
	);
}

function AgentsTab(props: { inspector: Inspector }): JSX.Element {
	const activity = () => props.inspector.agents();

	return (
		<>
			<div class="inspector-toolbar">
				<span class="inspector-note">
					{activity() === null
						? ""
						: `${activity()?.running ?? 0} running · ${activity()?.queued ?? 0} queued · ${activity()?.finished ?? 0} finished`}
				</span>
			</div>

			<Show when={activity() === null}>
				<p class="inspector-empty">
					{props.inspector.connected()
						? "The agent has not published subagent activity. The tab stays empty until it does."
						: "Waiting for the bridge before subagent activity can arrive."}
				</p>
			</Show>

			<Show when={activity() !== null && (activity()?.tasks.length ?? 0) === 0}>
				<p class="inspector-empty">No subagent activity right now.</p>
			</Show>

			<ul class="inspector-list">
				<For each={activity()?.tasks ?? []}>
					{(task) => (
						<li class="agent">
							<header>
								<span class={`agent-status ${task.status}`}>{task.status}</span>
								<span class="agent-label">{task.label}</span>
							</header>
							<div class="agent-meta mono">
								<span>{task.agent}</span>
								<span class="divider">·</span>
								<span>
									{task.turns} turns · {task.toolCalls} tools
								</span>
								<Show when={task.elapsedMs !== null}>
									<span class="divider">·</span>
									<span>{formatDuration(task.elapsedMs ?? 0)}</span>
								</Show>
							</div>
							<Show when={task.lastStep.length > 0}>
								<p class="agent-step">{task.lastStep}</p>
							</Show>
							<Show when={task.error}>{(error) => <p class="inspector-error">{error()}</p>}</Show>
						</li>
					)}
				</For>
			</ul>
		</>
	);
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}
