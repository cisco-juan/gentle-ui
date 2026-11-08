import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { AttachmentStrip } from "./AttachmentStrip";
import { Icon } from "./Icon";
import type { Attachment } from "../lib/attachments";
import { liveChat } from "../state/chat";

type Menu = "model" | "profile" | "permissions" | null;

/**
 * Composer.
 *
 * Everything that changes how the next message runs lives here as a clickable chip — model, profile,
 * permission mode — because a modal for a setting you change mid-thought breaks the thread.
 */
export function Composer(props: {
	onSend: (text: string, attachments?: readonly Attachment[]) => void;
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
	const [dragging, setDragging] = createSignal(false);
	const [copied, setCopied] = createSignal<string | null>(null);
	let area: HTMLTextAreaElement | undefined;

	// Attachments are chat state, not composer state: the app shell wires only `onSend(text)`, so the
	// controller the shell created owns the list and `send` drains it.
	const chat = () => liveChat();
	const attachments = () => chat()?.attachments() ?? [];
	// A file has no path until the bridge answers; sending early would leave the agent nothing to read.
	const uploading = () => attachments().some((entry) => entry.status === "uploading");

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

	onMount(() => {
		// The keymap layer cannot reach this textarea, so it relays the intent as an event.
		const onSubmit = (): void => submit();
		document.addEventListener("gentle:submit", onSubmit);
		onCleanup(() => document.removeEventListener("gentle:submit", onSubmit));
	});

	function submit(): void {
		const message = text().trim();
		const pending = attachments();
		if (uploading()) return;
		if (message.length === 0 && pending.length === 0) return;
		setText("");
		props.onSend(message, pending);
	}

	/** Attach the files of a drop or a paste; the controller classifies, reads and uploads them. */
	function attach(files: readonly File[]): void {
		const controller = chat();
		if (controller === null) return;
		void controller.attachFiles(files);
	}

	/** True when the drag carries files, as opposed to text the textarea should receive itself. */
	function carriesFiles(event: DragEvent): boolean {
		const transfer = event.dataTransfer;
		if (transfer === null) return false;
		if (transfer.items.length > 0) return Array.from(transfer.items).some((item) => item.kind === "file");
		return Array.from(transfer.types).includes("Files");
	}

	function onDragOver(event: DragEvent): void {
		// A text drag keeps its normal meaning and never highlights the composer.
		if (!carriesFiles(event)) {
			setDragging(false);
			return;
		}
		event.preventDefault();
		if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
		setDragging(true);
	}

	function onDragLeave(event: DragEvent): void {
		const next = event.relatedTarget;
		const current = event.currentTarget as unknown as Node | null;
		// Moving between the textarea, the chips and the strip stays inside the composer.
		if (next instanceof Node && current !== null && current.contains(next)) return;
		setDragging(false);
	}

	function onDrop(event: DragEvent): void {
		const files = Array.from(event.dataTransfer?.files ?? []);
		setDragging(false);
		if (files.length > 0) {
			event.preventDefault();
			attach(files);
			return;
		}

		// Dropped text is still text: insert it at the caret instead of losing it to an empty drop handler.
		const dropped = event.dataTransfer?.getData("text/plain") ?? "";
		if (dropped.length === 0) return;
		event.preventDefault();
		insert(dropped);
	}

	function onPaste(event: ClipboardEvent): void {
		const data = event.clipboardData;
		if (data === null) return;
		// Copied text keeps its normal behaviour; a clipboard image arrives as a file and becomes an attachment.
		if (data.getData("text/plain").length > 0) return;
		const files = Array.from(data.files);
		if (files.length === 0) return;
		event.preventDefault();
		attach(files);
	}

	function insert(value: string): void {
		const current = text();
		const at = area?.selectionStart ?? current.length;
		setText(`${current.slice(0, at)}${value}${current.slice(at)}`);
		queueMicrotask(() => {
			if (area === undefined) return;
			area.focus();
			area.selectionStart = at + value.length;
			area.selectionEnd = at + value.length;
		});
	}

	async function copyPath(path: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(path);
			setCopied(path);
			window.setTimeout(() => setCopied((current) => (current === path ? null : current)), 1400);
		} catch {
			// A webview without clipboard permission cannot copy; the path is still readable in the tooltip.
		}
	}

	function toggleMenu(next: Exclude<Menu, null>): void {
		setMenu((current) => (current === next ? null : next));
		setQuery("");
		if (next === "model" && props.models().length === 0) props.onLoadModels();
	}

	return (
		<div
			class="composer"
			classList={{ dragging: dragging() }}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			<Show when={dragging()}>
				<div class="composer-drop">drop to attach</div>
			</Show>
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

			<AttachmentStrip
				entries={attachments()}
				copied={copied()}
				onRemove={(id) => chat()?.removeAttachment(id)}
				onCopyPath={(path) => void copyPath(path)}
			/>

			<textarea
				ref={area}
				value={text()}
				placeholder={props.running() ? "agent is working — Esc to interrupt" : "Ask for something…  / for commands  ·  drop or paste a file"}
				rows={3}
				onInput={(event) => setText(event.currentTarget.value)}
				onPaste={onPaste}
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
					<button
						class="send"
						onClick={submit}
						disabled={uploading() || (text().trim().length === 0 && attachments().length === 0)}
					>
						Send
					</button>
				</div>
			</footer>
		</div>
	);
}
