import { For, Show, onMount, type JSX } from "solid-js";
import type { ThemeCatalogEntry } from "@gentle-shell/protocol";
import { formatChord, isMac } from "../lib/keybindings";
import { Icon } from "./Icon";

/** Centered sheet used by the settings and shortcut views. */
export function Sheet(props: { title: string; onClose: () => void; children: JSX.Element; wide?: boolean }) {
	let dialog: HTMLDivElement | undefined;
	// Focus moves into the sheet, so Escape reaches the keymap as a close instead of landing in the
	// composer, where it would interrupt the agent behind a sheet the reader is looking at.
	onMount(() => dialog?.focus());

	return (
		<div class="sheet-backdrop" onClick={() => props.onClose()}>
			<div
				class={props.wide === true ? "sheet wide" : "sheet"}
				ref={dialog}
				role="dialog"
				aria-modal="true"
				aria-label={props.title}
				tabindex={-1}
				onClick={(event) => event.stopPropagation()}
			>
				<header>
					<h2>{props.title}</h2>
					<button class="icon-btn" onClick={() => props.onClose()} title="Close">
						✕
					</button>
				</header>
				<div class="sheet-body">{props.children}</div>
			</div>
		</div>
	);
}

export function SettingsSheet(props: {
	facts: ReadonlyArray<{ label: string; value: string }>;
	/** Gentle Shell's own theme choice: the catalog this machine has, and the one Pi's settings select. */
	theme: {
		current: string | null;
		available: readonly ThemeCatalogEntry[];
		busy: boolean;
		error: string | null;
		onSelect: (name: string) => void;
	};
	onClose: () => void;
}) {
	return (
		<Sheet title="Settings" onClose={props.onClose}>
			<section>
				<h3>This session</h3>
				<dl class="facts">
					<For each={props.facts}>
						{(fact) => (
							<>
								<dt>{fact.label}</dt>
								<dd>{fact.value}</dd>
							</>
						)}
					</For>
				</dl>
			</section>
			<section>
				<h3>Theme</h3>
				<p class="muted">
					The theme Gentle Shell already uses, from the same settings file the terminal reads. Choosing one
					writes that file, so the terminal and this window agree.
				</p>
				<div class="chips">
					<For each={props.theme.available}>
						{(entry) => (
							<button
								class="chip"
								classList={{ open: entry.name === props.theme.current, model: entry.name === props.theme.current }}
								disabled={props.theme.busy}
								title={`${entry.name} · ${entry.source}`}
								onClick={() => props.theme.onSelect(entry.name)}
							>
								{entry.name}
							</button>
						)}
					</For>
				</div>
				<Show when={props.theme.available.length === 0}>
					<p class="muted">No theme was found on this machine yet.</p>
				</Show>
				<Show when={props.theme.error}>{(error) => <p class="notice error">{error()}</p>}</Show>
			</section>
			<section>
				<h3>Agent settings</h3>
				<p class="muted">
					Model, profile and permission mode are live in the composer. Packages, skills and MCP servers are
					read from the agent's own configuration; this shell does not edit them yet.
				</p>
			</section>
		</Sheet>
	);
}

const SHORTCUTS: ReadonlyArray<{ chord: string; action: string; ready: boolean }> = [
	{ chord: "Enter", action: "Send the message", ready: true },
	{ chord: "Shift+Enter", action: "New line", ready: true },
	{ chord: "Escape", action: "Interrupt the agent, or close a menu", ready: true },
	{ chord: "/", action: "List commands", ready: true },
	{ chord: "Mod+K", action: "Command palette: actions, threads, commands, models", ready: true },
	{ chord: "Mod+P", action: "Quick open a thread", ready: true },
	{ chord: "Mod+B", action: "Toggle the rail", ready: true },
	{ chord: "Mod+Alt+B", action: "Toggle the inspector", ready: true },
	{ chord: "Mod+Shift+K", action: "This list", ready: true },
	{ chord: "Mod+,", action: "Settings", ready: true },
];

export function ShortcutsSheet(props: { onClose: () => void }) {
	// The sheet has to name the keys this platform actually uses, not the abstract modifier.
	const mac = isMac(`${navigator.userAgent} ${navigator.platform}`);
	const pending = SHORTCUTS.filter((shortcut) => !shortcut.ready).length;

	return (
		<Sheet title="Shortcuts" onClose={props.onClose}>
			<ul class="shortcuts">
				<For each={SHORTCUTS}>
					{(shortcut) => (
						<li classList={{ planned: !shortcut.ready }}>
							<kbd>{formatChord(shortcut.chord, mac)}</kbd>
							<span>{shortcut.action}</span>
							<Show when={!shortcut.ready}>
								<span class="planned-tag">planned</span>
							</Show>
						</li>
					)}
				</For>
			</ul>
			<Show when={pending > 0}>
				<p class="muted">
					<Icon name="warn" size={12} /> Bindings marked planned are not wired yet, so the list never
					promises a key that does nothing.
				</p>
			</Show>
		</Sheet>
	);
}
