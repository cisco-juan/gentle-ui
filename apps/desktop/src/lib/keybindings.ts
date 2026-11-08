/**
 * Keyboard layer for the shell.
 *
 * Pure on purpose: no Solid, no `navigator`, no DOM. The caller supplies the platform string and the
 * event it wants matched, so the whole module is unit-testable under `node --test`.
 *
 * `Mod` is the only platform-dependent part of a chord: Meta on macOS, Control everywhere else.
 */

/** A parsed chord: one key plus the modifiers that must all be present, and no others. */
export interface Chord {
	readonly key: string;
	readonly mod: boolean;
	readonly shift: boolean;
	readonly alt: boolean;
	readonly ctrl: boolean;
}

/** Just enough of `KeyboardEvent` to match a chord. */
export interface KeyEventLike {
	readonly key: string;
	readonly metaKey?: boolean;
	readonly ctrlKey?: boolean;
	readonly shiftKey?: boolean;
	readonly altKey?: boolean;
	readonly target?: EditableTargetLike | null;
}

/** The parts of an event target that decide whether typing was meant for a field. */
export interface EditableTargetLike {
	readonly tagName?: string;
	readonly isContentEditable?: boolean;
}

export type ChordInput = Chord | string;

const MODIFIERS: Readonly<Record<string, "mod" | "shift" | "alt" | "ctrl">> = {
	mod: "mod",
	cmd: "mod",
	command: "mod",
	meta: "mod",
	super: "mod",
	shift: "shift",
	alt: "alt",
	option: "alt",
	opt: "alt",
	ctrl: "ctrl",
	control: "ctrl",
};

const KEY_ALIASES: Readonly<Record<string, string>> = {
	esc: "escape",
	escape: "escape",
	return: "enter",
	enter: "enter",
	space: "space",
	spacebar: "space",
	" ": "space",
	up: "arrowup",
	down: "arrowdown",
	left: "arrowleft",
	right: "arrowright",
	del: "delete",
};

const KEY_LABELS: Readonly<Record<string, string>> = {
	escape: "Esc",
	enter: "Enter",
	space: "Space",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	arrowup: "Up",
	arrowdown: "Down",
	arrowleft: "Left",
	arrowright: "Right",
};

/** True for platforms where `Mod` means Meta. Accepts a user agent or a bare platform string. */
export function isMac(platform: string): boolean {
	return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Parse `"Mod+Shift+K"` into a descriptor, ignoring modifier order and letter case. */
export function parseChord(source: string): Chord {
	let mod = false;
	let shift = false;
	let alt = false;
	let ctrl = false;
	let key = "";

	for (const part of source.split("+")) {
		const modifier = MODIFIERS[part.trim().toLowerCase()];
		if (modifier === "mod") mod = true;
		else if (modifier === "shift") shift = true;
		else if (modifier === "alt") alt = true;
		else if (modifier === "ctrl") ctrl = true;
		else key = part;
	}

	return { key: normalizeKey(key), mod, shift, alt, ctrl };
}

/** Does this event carry exactly this chord? An unexpected extra modifier means no match. */
export function matchEvent(event: KeyEventLike, chord: ChordInput, mac: boolean): boolean {
	const parsed = asChord(chord);
	if (normalizeKey(event.key) !== parsed.key) return false;

	const wantsMeta = parsed.mod && mac;
	const wantsCtrl = parsed.ctrl || (parsed.mod && !mac);

	return (
		(event.metaKey === true) === wantsMeta &&
		(event.ctrlKey === true) === wantsCtrl &&
		(event.shiftKey === true) === parsed.shift &&
		(event.altKey === true) === parsed.alt
	);
}

/** Render a chord the way its platform writes it: `⌘⇧K` on macOS, `Ctrl Shift K` elsewhere. */
export function formatChord(chord: ChordInput, mac: boolean): string {
	const parsed = asChord(chord);
	const key = KEY_LABELS[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);

	if (mac) {
		const prefix = `${parsed.mod ? "⌘" : ""}${parsed.ctrl ? "⌃" : ""}${parsed.alt ? "⌥" : ""}${parsed.shift ? "⇧" : ""}`;
		return `${prefix}${key}`;
	}

	const parts = new Set<string>();
	if (parsed.mod) parts.add("Ctrl");
	if (parsed.ctrl) parts.add("Ctrl");
	if (parsed.alt) parts.add("Alt");
	if (parsed.shift) parts.add("Shift");
	parts.add(key);
	return [...parts].join(" ");
}

/** Anything with a chord can be a binding; `id` is what a caller switches on. */
export interface KeyBinding {
	readonly id: string;
	readonly chord: string;
	readonly label: string;
}

/** Resolve an event to the first matching binding, or null. */
export type Keymap<T extends { readonly chord: string }> = (event: KeyEventLike) => T | null;

/**
 * Build a resolver over `bindings`, in order.
 *
 * Events that start inside an editable element are ignored unless the chord uses `Mod`: typing in the
 * composer must not fire the shell's shortcuts, while `Mod+Enter` is exactly how you send from it.
 */
export function createKeymap<T extends { readonly chord: string }>(
	bindings: readonly T[],
	mac: boolean,
): Keymap<T> {
	const parsed = bindings.map((binding) => ({ binding, chord: parseChord(binding.chord) }));

	return (event) => {
		const editable = isEditable(event.target);
		for (const entry of parsed) {
			if (editable && !entry.chord.mod) continue;
			if (matchEvent(event, entry.chord, mac)) return entry.binding;
		}
		return null;
	};
}

/** Every shortcut the shell promises, in resolution order. */
export const BINDINGS = [
	{ id: "palette", chord: "Mod+K", label: "Command palette" },
	{ id: "quick-open", chord: "Mod+P", label: "Quick open" },
	{ id: "rail", chord: "Mod+B", label: "Toggle the rail" },
	{ id: "shortcuts", chord: "Mod+Shift+K", label: "Keyboard shortcuts" },
	{ id: "settings", chord: "Mod+,", label: "Settings" },
	{ id: "send", chord: "Mod+Enter", label: "Send the message" },
	{ id: "close", chord: "Escape", label: "Close or interrupt" },
] as const satisfies readonly KeyBinding[];

export type CommandId = (typeof BINDINGS)[number]["id"];

function asChord(chord: ChordInput): Chord {
	return typeof chord === "string" ? parseChord(chord) : chord;
}

function normalizeKey(raw: string): string {
	const value = raw.trim().toLowerCase();
	if (value.length === 0) return raw.length > 0 ? "space" : "";
	return KEY_ALIASES[value] ?? value;
}

function isEditable(target: EditableTargetLike | null | undefined): boolean {
	if (!target) return false;
	if (target.isContentEditable === true) return true;
	const tag = (target.tagName ?? "").toLowerCase();
	return tag === "input" || tag === "textarea" || tag === "select";
}
