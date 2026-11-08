import { For, Show } from "solid-js";

/** Left rail: where the workspace lives and what the agent is doing right now. */
export function Sidebar(props: {
	project: string;
	connection: "connecting" | "connected" | "failed";
	statuses: Record<string, string>;
	onNewThread: () => void;
	onInterrupt: () => void;
}) {
	return (
		<aside class="sidebar">
			<div class="brand">
				<span class="logo">π</span>
				<span>gentle shell</span>
			</div>

			<nav class="rail">
				<span class="rail-item active">Chat</span>
				<span class="rail-item">Changes</span>
				<span class="rail-item">Files</span>
				<span class="rail-item">Tasks</span>
				<span class="rail-item">Memory</span>
				<span class="rail-item">Agents</span>
			</nav>

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
