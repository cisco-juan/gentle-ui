import { For, Show, createMemo, createSignal } from "solid-js";
import type { SessionSummary } from "@gentle-shell/protocol";
import { groupThreads, relativeTime, type ThreadGroup } from "../lib/threads";
import { Icon } from "./Icon";

/**
 * Left rail.
 *
 * Layout mirrors how the work is shaped: entry actions, then threads grouped by workspace, then the
 * two things that outlive the day — adding a project and settings. Only the thread list scrolls, so
 * the actions above and the settings below never move.
 */
export function Sidebar(props: {
	project: string;
	connection: "connecting" | "connected" | "failed";
	statuses: Record<string, string>;
	threads: readonly SessionSummary[];
	activePath: string | null;
	onNewThread: () => void;
	onSelectThread: (path: string) => void;
	onOpenSettings: () => void;
	onOpenShortcuts: () => void;
}) {
	const [query, setQuery] = createSignal("");
	const [searching, setSearching] = createSignal(false);
	const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());

	const filtered = createMemo(() => {
		const needle = query().trim().toLowerCase();
		if (needle.length === 0) return props.threads;
		return props.threads.filter(
			(thread) => thread.title.toLowerCase().includes(needle) || thread.cwd.toLowerCase().includes(needle),
		);
	});

	const groups = createMemo(() => groupThreads(filtered()));

	function toggleGroup(cwd: string): void {
		setCollapsed((current) => {
			const next = new Set(current);
			if (next.has(cwd)) next.delete(cwd);
			else next.add(cwd);
			return next;
		});
	}

	return (
		<aside class="sidebar">
			<div class="sidebar-head">
				<button class="icon-btn" title="Sidebar">
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
						setSearching((current) => !current);
						if (searching()) setQuery("");
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
					<span class="section-count">{filtered().length}</span>
				</div>

				<Show when={groups().length > 0} fallback={<p class="rail-empty">No saved threads yet.</p>}>
					<For each={groups()}>
						{(group) => (
							<ThreadGroupView
								group={group}
								activePath={props.activePath}
								collapsed={collapsed().has(group.cwd)}
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

function ThreadGroupView(props: {
	group: ThreadGroup;
	activePath: string | null;
	collapsed: boolean;
	onToggle: () => void;
	onSelect: (path: string) => void;
}) {
	return (
		<div class="thread-group">
			<button class="group-head" onClick={() => props.onToggle()}>
				<Icon name="chevron" class={`chevron ${props.collapsed ? "closed" : ""}`} size={12} />
				<Icon name="folder" size={13} />
				<span class="group-label">{props.group.label}</span>
				<span class="group-count">{props.group.items.length}</span>
			</button>

			<Show when={!props.collapsed}>
				<For each={props.group.items}>
					{(thread) => (
						<button
							class="thread"
							classList={{ active: thread.path === props.activePath }}
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
