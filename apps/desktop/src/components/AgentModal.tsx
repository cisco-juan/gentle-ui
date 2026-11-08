import { For, Show, onCleanup, onMount, type JSX } from "solid-js";
import { agentDuration } from "../lib/agents";
import type { AgentDetailView } from "../state/inspector";

/**
 * One subagent run, opened from a row in the Agents tab.
 *
 * The tab lists runs; this is the iteration behind one of them, in the order it happened: what the
 * subagent said, and every tool it called with the output it read back. It is a view of a file the agent
 * already wrote — nothing here runs, retries, or reports on the run.
 *
 * It follows the shell's sheet conventions: `role="dialog"`, focus moved inside so Escape reaches the
 * modal before the keymap reads it as an interrupt, and focus handed back to the row that opened it.
 */
export function AgentModal(props: { detail: AgentDetailView; onClose: () => void }): JSX.Element {
	const summary = () => props.detail.summary;
	const detail = () => props.detail.data;
	const label = (): string => summary()?.label ?? props.detail.taskId;
	const duration = (): string | null => {
		const row = summary();
		return row === null ? null : agentDuration(row);
	};

	let dialog: HTMLDivElement | undefined;
	let restore: Element | null = null;

	onMount(() => {
		restore = document.activeElement;
		dialog?.focus();
	});
	onCleanup(() => {
		if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
	});

	return (
		<div class="agent-modal-backdrop" onClick={() => props.onClose()}>
			<div
				class="agent-modal"
				ref={dialog}
				role="dialog"
				aria-modal="true"
				aria-label={`Agent run ${label()}`}
				tabindex={-1}
				onClick={(event) => event.stopPropagation()}
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					// Closed here, not by the shell's Escape binding: that one interrupts the agent.
					event.preventDefault();
					event.stopPropagation();
					props.onClose();
				}}
			>
				<header class="agent-modal-head">
					<span class={`agent-status ${summary()?.status ?? detail()?.status ?? "unknown"}`}>
						{summary()?.status ?? detail()?.status ?? "unknown"}
					</span>
					<h2>{label()}</h2>
					<button type="button" class="icon-btn" title="Close" aria-label="Close the run" onClick={() => props.onClose()}>
						✕
					</button>
				</header>

				<div class="agent-modal-meta mono">
					<span>{summary()?.agent ?? detail()?.agent ?? "agent"}</span>
					<Show when={summary()?.model}>
						{(model) => (
							<>
								<span class="divider">·</span>
								<span>{model()}</span>
							</>
						)}
					</Show>
					<Show when={duration()}>
						{(duration) => (
							<>
								<span class="divider">·</span>
								<span>{duration()}</span>
							</>
						)}
					</Show>
				</div>

				<div class="agent-modal-body">
					<Show when={props.detail.loading}>
						<p class="inspector-note">Reading this run…</p>
					</Show>
					<Show when={props.detail.error}>{(error) => <p class="inspector-error">{error()}</p>}</Show>
					<Show when={detail()}>
						{(run) => (
							<>
								<Show when={run().items.length === 0}>
									<p class="inspector-empty">This run published no steps.</p>
								</Show>
								<For each={run().items}>
									{(item) =>
										item.kind === "text" ? (
											<p class="agent-item">{item.text}</p>
										) : (
											<div class="agent-item agent-item-tool">
												<div class="agent-item-name mono">{item.name}</div>
												<pre>{item.output}</pre>
											</div>
										)
									}
								</For>
								<Show when={run().truncated}>
									<p class="inspector-note">This run is longer than the panel keeps; the end is what is shown.</p>
								</Show>
							</>
						)}
					</Show>
				</div>
			</div>
		</div>
	);
}
