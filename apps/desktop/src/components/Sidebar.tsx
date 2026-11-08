import { For, Show, createMemo } from "solid-js";
import type { SessionSummary } from "@gentle-shell/protocol";
import { groupThreads, relativeTime } from "../lib/threads";

/** Left rail: saved threads grouped by project, plus where the workspace lives and the live statuses. */
export function Sidebar(props: {
	project: string;
	connection: "connecting" | "connected" | "failed";
	statuses: Record<string, string>;
	threads: readonly SessionSummary[];
	activePath: string | null;
	onSelectThread: (path: string) => void;
	onNewThread: () => void;
	onInterrupt: () => void;
}) {
	const groups = createMemo(() => groupThreads(props.threads));

	return (
		<aside class="sidebar">
			<div class="brand">
				<span class="logo">π</span>
				<span>gentle shell</span>
			</div>

			<section class="threads">
				<p class="label">threads</p>
				<Show when={props.threads.length > 0} fallback={<p class="thread-empty">no saved threads yet</p>}>
					<For each={groups()}>
						{(group) => (
							<div class="thread-group">
								<p class="thread-project" title={group.cwd}>
									{group.label}
								</p>
								<For each={group.items}>
									{(thread) => (
										<button
											class="thread-item"
											classList={{ active: thread.path === props.activePath }}
											title={thread.path}
											onClick={() => props.onSelectThread(thread.path)}
										>
											<span class="thread-title">{thread.title}</span>
											<span class="thread-time">{relativeTime(thread.updatedAt)}</span>
										</button>
									)}
								</For>
							</div>
						)}
					</For>
				</Show>
			</section>

			<section class="project">
				<p class="label">workspace</p>
				<p class="path">{props.project}</p>
			</section>

			<div class="sidebar-actions">
				<button class="ghost" onClick={() => props.onNewThread()}>
					New thread
				</button>
				<button class="ghost" onClick={() => props.onInterrupt()}>
					Interrupt
				</button>
			</div>

			<Show when={Object.keys(props.statuses).length > 0}>
				<section class="statuses">
					<p class="label">status</p>
					<For each={Object.entries(props.statuses)}>
						{([key, text]) => (
							<p class="status-line">
								<span class="muted">{key}</span> {text}
							</p>
						)}
					</For>
				</section>
			</Show>

			<footer class={`connection ${props.connection}`}>
				<span class="dot" />
				{props.connection === "connected" ? "bridge ready" : props.connection}
			</footer>
		</aside>
	);
}
