import { For, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "./Icon";

type Menu = "model" | "profile" | "permissions" | null;

/**
 * Composer.
 *
 * Everything that changes how the next message runs lives here as a clickable chip — model, profile,
 * permission mode — because a modal for a setting you change mid-thought breaks the thread.
 */
export function Composer(props: {
	onSend: (text: string) => void;
	onInterrupt: () => void;
	running: () => boolean;
	model: () => string;
	profile: () => string;
	permissionMode: () => string;
	commands: () => ReadonlyArray<{ name: string; description: string }>;
	models: () => ReadonlyArray<{ provider: string; id: string }>;
	onLoadModels: () => void;
	onSwitchModel: (provider: string, id: string) => void;
	onRunCommand: (name: string) => void;
	onPermissionMode: (mode: string) => void;
}) {
	const [text, setText] = createSignal("");
	const [menu, setMenu] = createSignal<Menu>(null);
	const [query, setQuery] = createSignal("");

	const suggestions = createMemo(() => {
		const value = text();
		if (!value.startsWith("/")) return [];
		const needle = value.slice(1).toLowerCase();
		// Bare "/" must open on the shell's own commands, not on package noise: the agent advertises
		// 86 commands here and 36 of them are `gentle:*`, which is what a new user is looking for.
		return props
			.commands()
			.filter((command) => command.name.toLowerCase().includes(needle))
			.sort((left, right) => rank(left.name, needle) - rank(right.name, needle) || left.name.localeCompare(right.name))
			.slice(0, 14);
	});

	const filteredModels = createMemo(() => {
		const needle = query().trim().toLowerCase();
		const all = props.models();
		return needle.length === 0 ? all : all.filter((entry) => `${entry.provider}/${entry.id}`.toLowerCase().includes(needle));
	});

	const commandsMatching = (needle: string) => props.commands().filter((command) => command.name.toLowerCase().includes(needle));

	function rank(name: string, needle: string): number {
		const lower = name.toLowerCase();
		const group = lower.startsWith("gentle:") ? 0 : lower.startsWith("skill:") ? 2 : 1;
		const prefix = needle.length === 0 || lower.startsWith(needle) ? 0 : 1;
		return group * 2 + prefix;
	}

	function submit(): void {
		const message = text().trim();
		if (message.length === 0) return;
		setText("");
		props.onSend(message);
	}

	function toggleMenu(next: Exclude<Menu, null>): void {
		setMenu((current) => (current === next ? null : next));
		setQuery("");
		if (next === "model" && props.models().length === 0) props.onLoadModels();
	}

	return (
		<div class="composer">
			<Show when={menu() !== null}>
				<div class="menu-backdrop" onClick={() => setMenu(null)} />
			</Show>

			<Show when={suggestions().length > 0}>
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
				onInput={(event) => setText(event.currentTarget.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						if (menu() !== null) setMenu(null);
						else props.onInterrupt();
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
					<div class="chip-wrap">
						<button class="chip model" classList={{ open: menu() === "model" }} onClick={() => toggleMenu("model")}>
							{props.model() || "no model"}
							<Icon name="caret" size={11} />
						</button>
						<Show when={menu() === "model"}>
							<div class="popover">
								<input
									class="popover-search"
									placeholder="Filter models…"
									value={query()}
									onInput={(event) => setQuery(event.currentTarget.value)}
								/>
								<ul>
									<For each={filteredModels()}>
										{(entry) => (
											<li>
												<button
													onClick={() => {
														props.onSwitchModel(entry.provider, entry.id);
														setMenu(null);
													}}
												>
													<span class="mono">{entry.id}</span>
													<span class="muted">{entry.provider}</span>
												</button>
											</li>
										)}
									</For>
								</ul>
								<Show when={filteredModels().length === 0}>
									<p class="popover-empty">No models reported by the agent.</p>
								</Show>
							</div>
						</Show>
					</div>

					<div class="chip-wrap">
						<button class="chip" classList={{ open: menu() === "profile" }} onClick={() => toggleMenu("profile")}>
							profile: {props.profile()}
							<Icon name="caret" size={11} />
						</button>
						<Show when={menu() === "profile"}>
							<div class="popover">
								<For each={commandsMatching("profile")} fallback={<p class="popover-empty">This agent exposes no profile command.</p>}>
									{(command) => (
										<button
											class="popover-row"
											onClick={() => {
												props.onRunCommand(command.name);
												setMenu(null);
											}}
										>
											<span class="mono">/{command.name}</span>
											<span class="muted">{command.description}</span>
										</button>
									)}
								</For>
							</div>
						</Show>
					</div>

					<div class="chip-wrap">
						<button class="chip" classList={{ open: menu() === "permissions" }} onClick={() => toggleMenu("permissions")}>
							permissions: {props.permissionMode()}
							<Icon name="caret" size={11} />
						</button>
						<Show when={menu() === "permissions"}>
							<div class="popover">
								<For each={["normal", "auto", "yolo"]}>
									{(mode) => (
										<button
											class="popover-row"
											classList={{ current: props.permissionMode() === mode }}
											onClick={() => {
												props.onPermissionMode(mode);
												setMenu(null);
											}}
										>
											<span class="mono">{mode}</span>
										</button>
									)}
								</For>
								<p class="popover-note">Switches the agent's permission mode for this thread.</p>
							</div>
						</Show>
					</div>
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
