import { For, Show, createSignal, type JSX } from "solid-js";
import "../memory.css";
import { groupByType, projectLabel, type MemoryPanel } from "../state/memory";

/**
 * Engram's memory for this workspace, read-only.
 *
 * Every block is rendered from the bridge's typed answer, so a missing binary, a refused handshake, a
 * timeout or an answer that is not the JSON the panel reads appears as exactly that with its reason
 * beside it — never as an empty list that would look like "you have no memories".
 *
 * Selecting a hit expands its text under the row it belongs to; there is no second screen and nothing
 * to navigate back from.
 */
export function MemoryTab(props: { memory: MemoryPanel }): JSX.Element {
	const view = () => props.memory.view();
	const context = () => view().context;
	const results = () => view().results;
	const [draft, setDraft] = createSignal("");

	// The counts the head line shows: Engram's index is the wider total, its context answer the
	// narrower one, and either may be the only one that arrived.
	const counts = () => context()?.counts ?? null;
	const projectCount = () => {
		const index = view().projects;
		if (index !== null && index.state === "ok") return index.count;
		return counts()?.projects ?? null;
	};

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		void props.memory.search(draft());
	}

	return (
		<div class="memory">
			<div class="memory-head">
				<span class="memory-project" title={context()?.projectPath ?? ""}>
					{projectLabel(context())}
				</span>
				<button
					type="button"
					class="inspector-action"
					disabled={view().loading}
					onClick={() => void props.memory.refresh()}
				>
					{view().loading ? "reading…" : "refresh"}
				</button>
			</div>

			<form class="memory-search" onSubmit={submit}>
				<input
					class="memory-input"
					type="search"
					value={draft()}
					placeholder="search this project's memory"
					aria-label="Search memories"
					onInput={(event) => setDraft(event.currentTarget.value)}
				/>
				<button
					type="submit"
					class="inspector-action"
					disabled={view().searching || draft().trim().length === 0}
				>
					{view().searching ? "asking…" : "search"}
				</button>
			</form>

			<div class="memory-scroll">
				<Show when={view().error}>{(error) => <p class="inspector-error">{error()}</p>}</Show>

				<Show when={view().loading && context() === null}>
					<p class="inspector-empty">Reading this project's memory…</p>
				</Show>

				{/* The project Engram derived, and what it says it remembers, or exactly why it cannot say. */}
				<Show when={context()}>
					{(current) => (
						<Show
							when={current().state === "ok"}
							fallback={
								<Unanswerable
									what="the current project"
									state={current().state}
									reason={current().reason}
									message={current().message}
									raw={current().raw}
								/>
							}
						>
							<dl class="memory-counts">
								<Show when={counts()}>
									{(known) => (
										<>
											<dt>observations</dt>
											<dd class="mono">{known().observations}</dd>
											<dt>sessions</dt>
											<dd class="mono">{known().sessions}</dd>
										</>
									)}
								</Show>
								<dt>projects</dt>
								<dd class="mono">{projectCount() ?? "—"}</dd>
								<dt>source</dt>
								<dd class="mono">{current().projectSource || "—"}</dd>
							</dl>
						</Show>
					)}
				</Show>

				<Show when={results() === null && context()?.state === "ok"}>
					<p class="inspector-empty">Search this project's memory to see what earlier sessions learned.</p>
				</Show>

				<Show when={results()}>
					{(found) => (
						<Show
							when={found().state === "ok"}
							fallback={
								<Unanswerable
									what="this search"
									state={found().state}
									reason={found().reason}
									message={found().message}
									raw={found().raw}
								/>
							}
						>
							<Show when={found().observations.length === 0}>
								<section class="memory-block">
									<h3 class="memory-title">no matches</h3>
									<p class="inspector-empty">{found().message}</p>
								</section>
							</Show>

							<For each={groupByType(found().observations)}>
								{(group) => (
									<section class="memory-group">
										<h3 class="memory-type">
											<span>{group.type.length === 0 ? "untyped" : group.type}</span>
											<span class="memory-type-count mono">{group.observations.length}</span>
										</h3>
										<ul class="memory-list">
											<For each={group.observations}>
												{(observation, index) => {
													const key = () =>
														observation.id.length > 0 ? `#${observation.id}` : `${group.type}-${index()}`;
													return (
														<li>
															<button
																type="button"
																class={`memory-row${view().selectedId === key() ? " on" : ""}`}
																aria-expanded={view().selectedId === key()}
																onClick={() => props.memory.select(key())}
															>
																<span class="memory-id mono">{key()}</span>
																<span class="memory-row-title">
																	{observation.title.length === 0 ? "untitled observation" : observation.title}
																</span>
																<Show when={observation.pinned}>
																	<span class="memory-pin">pinned</span>
																</Show>
															</button>

															<Show when={view().selectedId === key()}>
																<div class="memory-detail">
																	<pre class="memory-text">
																		{observation.text.length === 0
																			? "Engram returned no text for this observation."
																			: observation.text}
																	</pre>
																	<Show when={observation.truncated}>
																		<p class="memory-note">
																			Engram returned a preview of this observation; the stored text is longer.
																		</p>
																	</Show>
																</div>
															</Show>
														</li>
													);
												}}
											</For>
										</ul>
									</section>
								)}
							</For>
						</Show>
					)}
				</Show>
			</div>
		</div>
	);
}

/**
 * A block that could not answer: the sentence, the reason in the bridge's vocabulary, and the raw
 * text when the answer arrived in a shape this panel does not read.
 */
function Unanswerable(props: {
	what: string;
	state: string;
	reason: string | null;
	message: string;
	raw: string | null;
}): JSX.Element {
	const title = () => (props.state === "unparsable" ? `unreadable answer for ${props.what}` : `no memory for ${props.what}`);

	return (
		<section class="memory-block">
			<h3 class="memory-title">{title()}</h3>
			<p class="inspector-empty">{props.message}</p>
			<Show when={props.reason}>{(reason) => <p class="memory-reason mono">{reason()}</p>}</Show>
			<Show when={props.raw}>{(raw) => <pre class="memory-raw">{raw()}</pre>}</Show>
		</section>
	);
}
