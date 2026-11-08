import { For, Show, type JSX } from "solid-js";
import { Icon } from "./Icon";

/** Centered sheet used by the settings and shortcut views. */
export function Sheet(props: { title: string; onClose: () => void; children: JSX.Element }) {
	return (
		<div class="sheet-backdrop" onClick={() => props.onClose()}>
			<div class="sheet" onClick={(event) => event.stopPropagation()}>
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
				<h3>Agent settings</h3>
				<p class="muted">
					Model, profile and permission mode are live in the composer. Packages, skills and MCP servers are
					read from the agent's own configuration; a full editor lands with the palette work.
				</p>
			</section>
		</Sheet>
	);
}

const SHORTCUTS: ReadonlyArray<{ keys: string; action: string; ready: boolean }> = [
	{ keys: "Enter", action: "Send the message", ready: true },
	{ keys: "Shift + Enter", action: "New line", ready: true },
	{ keys: "Esc", action: "Interrupt the agent, or close a menu", ready: true },
	{ keys: "/", action: "List commands", ready: true },
	{ keys: "Mod + K", action: "Command palette", ready: false },
	{ keys: "Mod + P", action: "Quick open thread or file", ready: false },
	{ keys: "Mod + B", action: "Toggle the rail", ready: false },
	{ keys: "Mod + ,", action: "Settings", ready: false },
];

export function ShortcutsSheet(props: { onClose: () => void }) {
	return (
		<Sheet title="Shortcuts" onClose={props.onClose}>
			<ul class="shortcuts">
				<For each={SHORTCUTS}>
					{(shortcut) => (
						<li classList={{ planned: !shortcut.ready }}>
							<kbd>{shortcut.keys}</kbd>
							<span>{shortcut.action}</span>
							<Show when={!shortcut.ready}>
								<span class="planned-tag">planned</span>
							</Show>
						</li>
					)}
				</For>
			</ul>
			<p class="muted">
				<Icon name="warn" size={12} /> Bindings marked planned are not wired yet; they arrive with the
				palette so the list never promises a key that does nothing.
			</p>
		</Sheet>
	);
}
