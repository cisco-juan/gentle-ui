import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { AttachmentStrip } from "./AttachmentStrip";
import { describeCommand } from "../lib/commands";
import { cycle } from "../lib/menu";
import { SkeletonLines } from "./Skeleton";
import { Icon } from "./Icon";
import type { PermissionMode, ProfilesView } from "@gentle-shell/protocol";
import type { Attachment } from "../lib/attachments";
import { permissionRows, type PermissionRow } from "../lib/permissions";
import type { PermissionsPanelView } from "../state/permissions";
import { liveChat } from "../state/chat";

type Menu = "model" | "profile" | "permissions" | null;

/** What the chip says: the default new threads start in, never a mode the open thread may not have. */
function permissionDefault(view: PermissionsPanelView): string {
	if (view.data === null) return "…";
	if (view.data.state !== "ok") return "unavailable";
	return view.data.default ?? "unknown";
}

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
	/** The permission default new threads start in, as the bridge reports it. */
	permissions: () => PermissionsPanelView;
	/**
	 * Write a mode as the default for new threads. Resolves once the attempt settled, so the menu can stay
	 * open over a refusal; the panel refuses an elevated mode before the request exists.
	 */
	onSetPermissionDefault: (mode: string) => Promise<void>;
	/** The mode the open thread reports over `gentle:mode`, when the agent has published one. */
	threadMode: () => PermissionMode | null;
	/** Ask the bridge again before the menu shows: the default is a file a terminal session may have changed. */
	onRefreshPermissions: () => void;
	commands: () => ReadonlyArray<{ name: string; description: string }>;
	models: () => ReadonlyArray<{ provider: string; id: string }>;
	onLoadModels: () => void;
	onSwitchModel: (provider: string, id: string) => void;
	onRunCommand: (name: string) => void;
	/** The profiles file as the bridge last read it, or null before the first answer. */
	profiles: () => ProfilesView | null;
	/** Make a profile the default and open a new thread that starts with it. */
	onUseProfile: (name: string) => void;
	onManageProfiles: () => void;
}) {
	const [text, setText] = createSignal("");
	const [menu, setMenu] = createSignal<Menu>(null);
	const [query, setQuery] = createSignal("");
	const [dragging, setDragging] = createSignal(false);
	// The slash suggestion the arrow keys are on; -1 until one is chosen, so Enter still sends the line.
	const [picked, setPicked] = createSignal(-1);
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
		// Typing is the main activity here, so the field takes focus instead of being clicked first.
		area?.focus();
		// Escape from outside the textarea (a chip, a popover row) asks the composer to close its own
		// menu first; cancelling the event tells the shell not to read the same key as "interrupt".
		const onDismiss = (event: Event): void => {
			if (menu() === null) return;
			event.preventDefault();
			setMenu(null);
		};
		const onFocusRequest = (): void => area?.focus();
		// A click anywhere outside the chips closes an open menu. A document listener rather than a
		// full-window backdrop: a fixed overlay over the transcript swallows its wheel events, so a menu
		// left open made the chat unscrollable.
		const onPointerDown = (event: PointerEvent): void => {
			if (menu() === null) return;
			// A chip press toggles its own menu, and a popover row closes it itself; closing here first
			// would only make the same gesture reopen it.
			const inside = event.target instanceof Element ? event.target.closest(".chip-wrap") : null;
			if (inside !== null) return;
			setMenu(null);
		};
		document.addEventListener("gentle:dismiss", onDismiss);
		document.addEventListener("gentle:focus-composer", onFocusRequest);
		document.addEventListener("pointerdown", onPointerDown, true);
		onCleanup(() => {
			document.removeEventListener("gentle:submit", onSubmit);
			document.removeEventListener("gentle:dismiss", onDismiss);
			document.removeEventListener("gentle:focus-composer", onFocusRequest);
			document.removeEventListener("pointerdown", onPointerDown, true);
		});
	});

	function submit(): void {
		const message = text().trim();
		const pending = attachments();
		if (uploading()) return;
		if (message.length === 0 && pending.length === 0) return;
		const controller = chat();
		if (controller !== null && controller.connection() !== "connected") {
			// Clearing the field first would throw away what was typed for a message that cannot be sent.
			controller.notify("the agent is not connected; your message was kept", "error");
			return;
		}
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
		if (next === "permissions") props.onRefreshPermissions();
	}

	/**
	 * Apply a lower default from the menu.
	 *
	 * The menu stays open when the bridge refused it or there was no bridge to ask: the refusal is the
	 * only thing the person needs to read, and closing would hide it behind a chip that did not move.
	 */
	async function chooseMode(row: PermissionRow): Promise<void> {
		if (!row.settable) return;
		await props.onSetPermissionDefault(row.mode);
		if (props.permissions().error !== null) return;
		// A new thread was opened for it, so the keyboard belongs back in the composer.
		setMenu(null);
		area?.focus();
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

			<Show when={suggestions().length > 0}>
				<ul class="suggestions">
					<For each={suggestions()}>
						{(command, index) => (
							<li
								classList={{ active: index() === picked() }}
								onMouseDown={(event) => {
									event.preventDefault();
									setText(`/${command.name} `);
									setPicked(-1);
								}}
							>
								<span class="command">/{command.name}</span>
								<Show when={describeCommand(command.name).kind === "terminal"}>
									<span class="cmd-tag">terminal</span>
								</Show>
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
				onInput={(event) => {
					setText(event.currentTarget.value);
					setPicked(-1);
				}}
				onPaste={onPaste}
				onKeyDown={(event) => {
					const shown = suggestions();
					if (shown.length > 0 && !event.isComposing) {
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							setPicked(cycle(picked(), event.key === "ArrowDown" ? 1 : -1, shown.length));
							return;
						}
						// Tab completes the chosen row (the first when none is); Enter does so only once an arrow
						// chose one, so typing a whole command and pressing Enter still sends it.
						const completes = (event.key === "Tab" && !event.shiftKey) || (event.key === "Enter" && !event.shiftKey && picked() >= 0);
						const row = shown[picked() >= 0 ? picked() : 0];
						if (completes && row !== undefined) {
							event.preventDefault();
							setText(`/${row.name} `);
							setPicked(-1);
							return;
						}
					}
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
									onKeyDown={(event) => {
										// The global keymap skips editable fields, so a field inside a popover closes it itself.
										if (event.key !== "Escape") return;
										event.preventDefault();
										setMenu(null);
										area?.focus();
									}}
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
									<Show when={chat()?.modelsLoading() ?? false} fallback={<p class="popover-empty">No models reported by the agent.</p>}>
										<SkeletonLines count={5} label="Loading models" />
									</Show>
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
								<Show
									when={props.profiles()?.state === "ok"}
									fallback={<p class="popover-empty">{props.profiles()?.message || "Profiles are not loaded yet."}</p>}
								>
									<For each={props.profiles()?.profiles ?? []} fallback={<p class="popover-empty">No profiles yet.</p>}>
										{(profile) => (
											<button
												class="popover-row"
												title="Make it the default and open a new thread with it"
												onClick={() => {
													props.onUseProfile(profile.name);
													setMenu(null);
												}}
											>
												<span class="mono">{profile.name}</span>
												<span class="muted">{profile.active ? "default" : "use for new threads"}</span>
											</button>
										)}
									</For>
								</Show>
								<button
									class="popover-row"
									onClick={() => {
										props.onManageProfiles();
										setMenu(null);
									}}
								>
									<span>Manage profiles…</span>
								</button>
							</div>
						</Show>
					</div>

					<div class="chip-wrap">
						<button
							class="chip"
							classList={{ open: menu() === "permissions" }}
							title="The permission mode new threads start in"
							onClick={() => toggleMenu("permissions")}
						>
							permissions: {permissionDefault(props.permissions())}
							<Icon name="caret" size={11} />
						</button>
						<Show when={menu() === "permissions"}>
							<div class="popover">
								<For each={permissionRows(props.permissions().data)}>
									{(row) => (
										<button
											class="popover-row"
											classList={{ current: row.current }}
											// An elevated mode is not a choice this menu offers: it is set in a terminal, and the
											// bridge would refuse it anyway, so the row is not clickable at all.
											disabled={!row.settable || props.permissions().busy}
											title={row.terminal === null ? `New threads start in ${row.mode}` : `Set in a terminal: ${row.terminal}`}
											onClick={() => void chooseMode(row)}
										>
											{/* The current mode is marked, not just tinted: a colour alone is not a label. */}
											<span class="popover-check">{row.current ? "\u2713" : ""}</span>
											<span class="mono">{row.mode}</span>
											<Show when={row.current}>
												<span class="muted">default</span>
											</Show>
											<Show when={row.terminal}>
												<span class="muted">set in a terminal</span>
											</Show>
										</button>
									)}
								</For>
								<p class="popover-note">
									New threads start in the mode marked default; the open thread keeps the one it started with.
								</p>
								<Show when={props.threadMode()}>{(mode) => <p class="popover-note">This thread reports {mode()}.</p>}</Show>
								<Show when={permissionRows(props.permissions().data).some((row) => !row.settable)}>
									<p class="popover-note">
										Raising it is a terminal job:{" "}
										<span class="mono">
											{permissionRows(props.permissions().data)
												.filter((row) => !row.settable)
												.map((row) => row.terminal)
												.join(" · ")}
										</span>
									</p>
								</Show>
								<Show when={props.permissions().error}>{(text) => <p class="popover-note">Not applied: {text()}</p>}</Show>
								<Show when={props.permissions().notice}>{(text) => <p class="popover-note">{text()}</p>}</Show>
								<Show when={props.permissions().data?.message}>{(text) => <p class="popover-note">{text()}</p>}</Show>
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
