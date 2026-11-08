import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { SessionSummary } from "@gentle-shell/protocol";
import { groupThreads, relativeTime, type ThreadGroup } from "../lib/threads";
import { Icon } from "./Icon";
import { Skeleton } from "./Skeleton";

/**
 * Left rail.
 *
 * Layout mirrors how the work is shaped: entry actions, then threads grouped by workspace, then the
 * two things that outlive the day — adding a project and settings. Only the thread list scrolls, so
 * the actions above and the settings below never move.
 */
export function Sidebar(props: {
	project: string;
	connection: "connecting" | "connected" | "failed" | "disconnected";
	/** True until the bridge has answered once: the rail shows a skeleton, not "no threads". */
	loading: boolean;
	/** The thread being opened, marked on its row until its history is on screen. */
	opening: string | null;
	statuses: Record<string, string>;
	threads: readonly SessionSummary[];
	activePath: string | null;
	onCollapse: () => void;
	onNewThread: () => void;
	onSelectThread: (path: string) => void;
	onOpenSettings: () => void;
	onOpenShortcuts: () => void;
}) {
	const [query, setQuery] = createSignal("");
	const [searching, setSearching] = createSignal(false);
	// Groups start folded: 76 threads all expanded is a wall, not a workspace. The group holding the
	// open thread (or the newest one) opens on first paint.
	const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
	let seeded = false;

	const filtered = createMemo(() => {
		const needle = query().trim().toLowerCase();
		if (needle.length === 0) return props.threads;
		return props.threads.filter(
			(thread) => thread.title.toLowerCase().includes(needle) || thread.cwd.toLowerCase().includes(needle),
		);
	});

	const groups = createMemo(() => groupThreads(filtered()));

	createEffect(() => {
		const list = groups();
		if (list.length === 0) return;

		const active = list.find((group) => group.items.some((thread) => thread.path === props.activePath));
		if (!seeded) {
			seeded = true;
			const first = active ?? list[0];
			if (first) setExpanded(new Set([first.cwd]));
			return;
		}
		// Following a thread that lives in a folded group unfolds it instead of hiding the selection.
		if (active && !expanded().has(active.cwd)) {
			setExpanded((current) => new Set([...current, active.cwd]));
		}
	});

	function toggleGroup(cwd: string): void {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(cwd)) next.delete(cwd);
			else next.add(cwd);
			return next;
		});
	}

	return (
		<aside class="sidebar">
			<div class="sidebar-head">
				<button class="icon-btn" title="Hide the sidebar" aria-label="Hide the sidebar" onClick={() => props.onCollapse()}>
					<Icon name="panel" />
				</button>
				<span class="brand-text">gentle shell</span>
			</div>

			<div class="sidebar-actions">
				<button class="action" onClick={() => props.onNewThread()}>
					<Icon name="plus" />
					<span>New thread</span>
				</button>
				<button
					class="action"
					classList={{ on: searching() }}
					onClick={() => {
						// Read the state it is going to, not the one it was: clearing "after" the flip cleared
						// the query on opening and left the list filtered after closing.
						const opening = !searching();
						setSearching(opening);
						if (!opening) setQuery("");
					}}
				>
					<Icon name="search" />
					<span>Search</span>
				</button>
				<button class="action" onClick={() => props.onOpenShortcuts()}>
					<Icon name="keyboard" />
					<span>Shortcuts</span>
				</button>
			</div>

			<Show when={searching()}>
				<input
					class="rail-search"
					autofocus
					placeholder="Filter threads…"
					value={query()}
					onInput={(event) => setQuery(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							setQuery("");
							setSearching(false);
						}
					}}
				/>
			</Show>

			<div class="sidebar-scroll">
				<div class="section-head">
					<span>Threads</span>
				</div>

				<Show
					when={groups().length > 0}
					fallback={
						<Show when={props.loading} fallback={<p class="rail-empty">No saved threads yet.</p>}>
							<ThreadsSkeleton />
						</Show>
					}
				>
					<For each={groups()}>
						{(group) => (
							<ThreadGroupView
								group={group}
								activePath={props.activePath}
								opening={props.opening}
								collapsed={!expanded().has(group.cwd)}
								onToggle={() => toggleGroup(group.cwd)}
								onSelect={props.onSelectThread}
							/>
						)}
					</For>
				</Show>
			</div>

			<div class="sidebar-foot">
				<button class="action" onClick={() => props.onOpenSettings()}>
					<Icon name="settings" />
					<span>Settings</span>
				</button>
				<span class="connection" title={props.connection}>
					<span class={`dot ${props.connection}`} />
				</span>
			</div>
		</aside>
	);
}

/** Rows shaped like the thread list, so the rail keeps its layout while the list is on its way. */
function ThreadsSkeleton() {
	const titles = ["78%", "62%", "84%", "55%", "70%", "66%", "48%"];
	return (
		<div class="skeleton-rows" role="status" aria-busy="true" aria-label="Loading threads">
			<Skeleton width="38%" height="11px" />
			<For each={titles}>
				{(width) => (
					<div class="skeleton-row">
						<Skeleton width={width} height="10px" />
						<Skeleton width="22px" height="9px" />
					</div>
				)}
			</For>
		</div>
	);
}

function ThreadGroupView(props: {
	group: ThreadGroup;
	activePath: string | null;
	opening: string | null;
	collapsed: boolean;
	onToggle: () => void;
	onSelect: (path: string) => void;
}) {
	return (
		<div class="thread-group">
			<button class="group-head" onClick={() => props.onToggle()}>
				<Icon name="chevron" class={`chevron ${props.collapsed ? "closed" : ""}`} size={11} />
				<Icon name="folder" size={13} />
				<span class="group-label">{props.group.label}</span>
			</button>

			<Show when={!props.collapsed}>
				<For each={props.group.items}>
					{(thread) => (
						<button
							class="thread"
							classList={{ active: thread.path === props.activePath, pending: thread.path === props.opening }}
							aria-busy={thread.path === props.opening}
							title={`${thread.title}\n${thread.path}`}
							onClick={() => props.onSelect(thread.path)}
						>
							<span class="thread-dot" />
							<span class="thread-title">{thread.title}</span>
							<span class="thread-time">{relativeTime(thread.updatedAt)}</span>
						</button>
					)}
				</For>
			</Show>
		</div>
	);
}
