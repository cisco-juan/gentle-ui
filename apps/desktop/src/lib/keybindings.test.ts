// This package has no `@types/node`: the runner is Node's own, and the task that added the test script
// could not install type definitions. The two directives keep `tsc --noEmit` honest about every other line;
// drop them once `@types/node` is a devDependency here.
// @ts-expect-error -- node built-in types are not installed for this package
import assert from "node:assert/strict";
// @ts-expect-error -- node built-in types are not installed for this package
import test from "node:test";
import {
	BINDINGS,
	createKeymap,
	formatChord,
	isMac,
	matchEvent,
	parseChord,
	type EditableTargetLike,
	type KeyEventLike,
} from "./keybindings.ts";

type Modifiers = { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean };

function keydown(key: string, modifiers: Modifiers = {}, target: EditableTargetLike | null = null): KeyEventLike {
	return {
		key,
		metaKey: modifiers.meta ?? false,
		ctrlKey: modifiers.ctrl ?? false,
		shiftKey: modifiers.shift ?? false,
		altKey: modifiers.alt ?? false,
		target,
	};
}

const INPUT: EditableTargetLike = { tagName: "INPUT" };
const TEXTAREA: EditableTargetLike = { tagName: "textarea" };
const CONTENT_EDITABLE: EditableTargetLike = { tagName: "DIV", isContentEditable: true };
const BODY: EditableTargetLike = { tagName: "BODY" };

test("isMac reads the platform string the caller supplies", () => {
	assert.equal(isMac("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), true);
	assert.equal(isMac("MacIntel"), true);
	assert.equal(isMac("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), true);
	assert.equal(isMac("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), false);
	assert.equal(isMac("Win32"), false);
	assert.equal(isMac("Mozilla/5.0 (X11; Linux x86_64)"), false);
	assert.equal(isMac(""), false);
});

test("parseChord normalises modifier order, case and aliases", () => {
	assert.deepEqual(parseChord("Mod+Shift+K"), { key: "k", mod: true, shift: true, alt: false, ctrl: false });
	assert.deepEqual(parseChord("mod+shift+k"), { key: "k", mod: true, shift: true, alt: false, ctrl: false });
	assert.deepEqual(parseChord("Shift+Mod+K"), { key: "k", mod: true, shift: true, alt: false, ctrl: false });
	assert.deepEqual(parseChord("Mod+,"), { key: ",", mod: true, shift: false, alt: false, ctrl: false });
	assert.deepEqual(parseChord("Mod+Enter"), { key: "enter", mod: true, shift: false, alt: false, ctrl: false });
	assert.deepEqual(parseChord("Escape"), { key: "escape", mod: false, shift: false, alt: false, ctrl: false });
	assert.deepEqual(parseChord("Option+Up"), { key: "arrowup", mod: false, shift: false, alt: true, ctrl: false });
	assert.deepEqual(parseChord("Control+Space"), { key: "space", mod: false, shift: false, alt: false, ctrl: true });
});

test("Mod maps to Meta on macOS and Control elsewhere", () => {
	const chord = parseChord("Mod+K");

	assert.equal(matchEvent(keydown("k", { meta: true }), chord, true), true);
	assert.equal(matchEvent(keydown("k", { ctrl: true }), chord, true), false);

	assert.equal(matchEvent(keydown("k", { ctrl: true }), chord, false), true);
	assert.equal(matchEvent(keydown("k", { meta: true }), chord, false), false);
});

test("an event with unexpected extra modifiers never matches", () => {
	assert.equal(matchEvent(keydown("k", { meta: true, shift: true }), parseChord("Mod+K"), true), false);
	assert.equal(matchEvent(keydown("k", { meta: true, alt: true }), parseChord("Mod+K"), true), false);
	assert.equal(matchEvent(keydown("k"), parseChord("Mod+K"), true), false);
	assert.equal(matchEvent(keydown("k", { meta: true }), parseChord("Mod+Shift+K"), true), false);
	assert.equal(matchEvent(keydown("k", { ctrl: true, alt: true }), parseChord("Mod+K"), false), false);
	assert.equal(matchEvent(keydown("j", { meta: true }), parseChord("Mod+K"), true), false);
});

test("keyed aliases match the same physical key", () => {
	assert.equal(matchEvent(keydown("Esc"), parseChord("Escape"), false), true);
	assert.equal(matchEvent(keydown("Return"), parseChord("Enter"), false), true);
	assert.equal(matchEvent(keydown(" "), parseChord("Space"), false), true);
	assert.equal(matchEvent(keydown("K", { meta: true }), parseChord("Mod+K"), true), true);
});

test("editable elements are suppressed unless the chord uses Mod", () => {
	const resolve = createKeymap(BINDINGS, false);

	assert.equal(resolve(keydown("Escape", {}, INPUT))?.id, undefined);
	assert.equal(resolve(keydown("Escape", {}, TEXTAREA))?.id, undefined);
	assert.equal(resolve(keydown("Escape", {}, CONTENT_EDITABLE))?.id, undefined);
	assert.equal(resolve(keydown("Escape", {}, BODY))?.id, "close");

	assert.equal(resolve(keydown("k", { ctrl: true }, INPUT))?.id, "palette");
	assert.equal(resolve(keydown("k", { ctrl: true }, TEXTAREA))?.id, "palette");
	assert.equal(resolve(keydown("Enter", { ctrl: true }, TEXTAREA))?.id, "send");
});

test("formatChord renders platform-native labels", () => {
	assert.equal(formatChord("Mod+Shift+K", true), "⌘⇧K");
	assert.equal(formatChord("Mod+K", true), "⌘K");
	assert.equal(formatChord("Mod+,", true), "⌘,");
	assert.equal(formatChord("Mod+Shift+K", false), "Ctrl Shift K");
	assert.equal(formatChord("Mod+Alt+P", false), "Ctrl Alt P");
	assert.equal(formatChord("Escape", false), "Esc");
	assert.equal(formatChord("Mod+Enter", false), "Ctrl Enter");
	assert.equal(formatChord(parseChord("Mod+Shift+K"), false), "Ctrl Shift K");
});

test("keymap resolves the first matching binding and ignores the rest", () => {
	const first = { id: "first", chord: "Mod+K" };
	const second = { id: "second", chord: "Mod+K" };
	const resolve = createKeymap([first, second], true);

	assert.equal(resolve(keydown("k", { meta: true })), first);
	assert.equal(resolve(keydown("k", { ctrl: true })), null);
	assert.equal(resolve(keydown("p", { meta: true })), null);
});

test("the shipped bindings cover every command the shell advertises", () => {
	assert.deepEqual(
		BINDINGS.map((binding) => [binding.id, binding.chord]),
		[
			["palette", "Mod+K"],
			["quick-open", "Mod+P"],
			["rail", "Mod+B"],
			["shortcuts", "Mod+Shift+K"],
			["settings", "Mod+,"],
			["send", "Mod+Enter"],
			["close", "Escape"],
		],
	);

	const resolve = createKeymap(BINDINGS, true);
	assert.equal(resolve(keydown("k", { meta: true }))?.id, "palette");
	assert.equal(resolve(keydown("p", { meta: true }))?.id, "quick-open");
	assert.equal(resolve(keydown("b", { meta: true }))?.id, "rail");
	assert.equal(resolve(keydown("k", { meta: true, shift: true }))?.id, "shortcuts");
	assert.equal(resolve(keydown(",", { meta: true }))?.id, "settings");
	assert.equal(resolve(keydown("Enter", { meta: true }))?.id, "send");
	assert.equal(resolve(keydown("Escape"))?.id, "close");
});
