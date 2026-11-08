import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import "../palette.css";

export interface PaletteItem {
	readonly id: string;
	readonly label: string;
	readonly hint?: string;
	readonly run: () => void;
}

export interface PaletteGroup {
	readonly title: string;
	readonly items: ReadonlyArray<PaletteItem>;
}

/**
 * Command palette.
 *
 * The keyboard path to what the shell already shows: threads, slash commands, models, sheets. It owns no
 * data — the parent supplies the groups, so filtering here never touches the agent.
 */
export function Palette(props: {
	open: boolean;
	onClose: () => void;
	groups: ReadonlyArray<PaletteGroup>;
}) {
	const [query, setQuery] = createSignal("");
	const [active, setActive] = createSignal(0);

	// Parent order is kept; a group with nothing left to show disappears instead of leaving a stub title.
	const groups = createMemo(() => {
		const needle = query().trim().toLowerCase();
		let next = 0;
		return props.groups
			.map((group) => ({
				title: group.title,
				items: group.items
					.filter((item) => matches(item, needle))
					.map((item) => ({ item, index: next++ })),
			}))
			.filter((group) => group.items.length > 0);
	});

	const entries = createMemo(() => groups().flatMap((group) => group.items));
	const selected = createMemo(() => entries()[active()]?.item);

	let input: HTMLInputElement | undefined;
	const rows = new Map<number, HTMLElement>();

	// A palette that keeps the previous query, a stale row index or a detached input is worse than a closed one.
	createEffect(() => {
		if (!props.open) {
			input = undefined;
			rows.clear();
			return;
		}
		setQuery("");
		setActive(0);
		rows.clear();
		queueMicrotask(() => input?.focus());
	});

	createEffect(() => {
		rows.get(active())?.scrollIntoView({ block: "nearest" });
	});

	function run(item: PaletteItem): void {
		props.onClose();
		item.run();
	}

	function move(delta: number): void {
		const count = entries().length;
		if (count === 0) return;
		setActive((current) => (current + delta + count) % count);
	}

	return (
		<Show when={props.open}>
			<div class="palette-backdrop" onMouseDown={() => props.onClose()}>
				<div
					class="palette"
					role="dialog"
					aria-modal="true"
					aria-label="Command palette"
					onMouseDown={(event) => event.stopPropagation()}
					onKeyDown={(event) => {
						// Let an input method finish composing before any key is treated as a command.
						if (event.isComposing) return;
						if (event.key === "Escape") {
							event.preventDefault();
							props.onClose();
							return;
						}
						if (event.key === "ArrowDown") {
							event.preventDefault();
							move(1);
							return;
						}
						if (event.key === "ArrowUp") {
							event.preventDefault();
							move(-1);
							return;
						}
						if (event.key === "Enter") {
							event.preventDefault();
							const item = selected();
							if (item) run(item);
						}
					}}
				>
					<input
						ref={(element) => (input = element)}
						class="palette-input"
						value={query()}
						placeholder="Search commands, threads, models…"
						aria-label="Search"
						autocomplete="off"
						spellcheck={false}
						onInput={(event) => {
							setQuery(event.currentTarget.value);
							setActive(0);
							rows.clear();
						}}
					/>

					<div class="palette-body">
						<Show when={entries().length === 0}>
							<p class="palette-empty">
								{query().trim().length === 0 ? "No commands available." : `Nothing matches “${query().trim()}”.`}
							</p>
						</Show>

						<For each={groups()}>
							{(group) => (
								<section class="palette-group">
									<h2 class="palette-group-title">{group.title}</h2>
									<ul>
										<For each={group.items}>
											{(entry) => (
												<li>
													<button
														ref={(element) => rows.set(entry.index, element)}
														class="palette-item"
														classList={{ active: entry.index === active() }}
														onMouseEnter={() => setActive(entry.index)}
														onClick={() => run(entry.item)}
													>
														<span class="palette-item-label">{entry.item.label}</span>
														<Show when={entry.item.hint}>
															<span class="palette-item-hint">{entry.item.hint}</span>
														</Show>
													</button>
												</li>
											)}
										</For>
									</ul>
								</section>
							)}
						</For>
					</div>

					<p class="palette-foot">
						<span>↑↓ move</span>
						<span>↵ run</span>
						<span>esc close</span>
					</p>
				</div>
			</div>
		</Show>
	);
}

/** Case-insensitive substring match over the label or the hint. */
function matches(item: PaletteItem, needle: string): boolean {
	if (needle.length === 0) return true;
	return item.label.toLowerCase().includes(needle) || (item.hint?.toLowerCase().includes(needle) ?? false);
}
