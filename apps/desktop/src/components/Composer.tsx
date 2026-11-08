import { For, Show, createSignal, type Accessor } from "solid-js";

/** Composer: the only place a prompt starts. Enter sends, Shift+Enter breaks the line, Esc interrupts. */
export function Composer(props: {
	onSend: (text: string) => void;
	onInterrupt: () => void;
	running: Accessor<boolean>;
	model: Accessor<string>;
	commands: Accessor<Array<{ name: string; description: string }>>;
}) {
	const [text, setText] = createSignal("");
	const [showCommands, setShowCommands] = createSignal(false);

	const suggestions = () => {
		const query = text();
		if (!query.startsWith("/")) return [];
		const needle = query.slice(1).toLowerCase();
		return props.commands().filter((command) => command.name.toLowerCase().includes(needle)).slice(0, 8);
	};

	function submit(): void {
		const message = text().trim();
		if (message.length === 0) return;
		setText("");
		setShowCommands(false);
		props.onSend(message);
	}

	return (
		<div class="composer">
			<Show when={suggestions().length > 0 && showCommands()}>
				<ul class="suggestions">
					<For each={suggestions()}>
						{(command) => (
							<li
								onMouseDown={(event) => {
									event.preventDefault();
									setText(`/${command.name} `);
								}}
							>
								<span class="command">/{command.name}</span>
								<span class="muted">{command.description}</span>
							</li>
						)}
					</For>
				</ul>
			</Show>

			<textarea
				value={text()}
				placeholder={props.running() ? "agent is working — Esc to interrupt" : "Ask for something…  / for commands"}
				rows={3}
				onInput={(event) => {
					setText(event.currentTarget.value);
					setShowCommands(event.currentTarget.value.startsWith("/"));
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						props.onInterrupt();
						return;
					}
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						submit();
					}
				}}
			/>

			<footer>
				<div class="chips">
					<span class="chip model">{props.model() || "no model"}</span>
					<span class="chip muted-chip">profile: default</span>
					<span class="chip muted-chip">permissions: normal</span>
				</div>
				<div class="actions">
					<Show when={props.running()}>
						<button class="ghost" onClick={() => props.onInterrupt()}>
							Stop
						</button>
					</Show>
					<button class="send" onClick={submit} disabled={text().trim().length === 0}>
						Send
					</button>
				</div>
			</footer>
		</div>
	);
}
