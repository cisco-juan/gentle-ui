import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedTheme } from "@gentle-shell/protocol";
import {
	applyCssVariables,
	cssValueOf,
	cssVariablesOf,
	namesToResolve,
	themeNameFor,
	type StyleSink,
} from "./appearance.ts";

/** A theme resolved by the bridge, in the shape `Gentleman-Sexy` resolves to. */
function resolved(tokens: Record<string, string> = {}): ResolvedTheme {
	return {
		name: "Gentleman-Sexy",
		tokens: {
			text: "#F6EFF3",
			muted: "#A78E9B",
			dim: "#76616B",
			accent: "#F43888",
			borderMuted: "#2A1720",
			success: "#B4E7C7",
			warning: "#F2B86D",
			error: "#FF718F",
			selectedBg: "#28121E",
			userMessageBg: "#2E0F1F",
			pageBg: "#060407",
			cardBg: "#100A0F",
			...tokens,
		},
	};
}

test("a resolved theme becomes the app's own variables, not a restyled component", () => {
	assert.deepEqual(cssVariablesOf(resolved()), {
		"--bg": "#060407",
		"--rail": "#100A0F",
		"--surface": "#100A0F",
		"--surface-2": "#28121E",
		"--surface-3": "#2E0F1F",
		"--hairline": "#2A1720",
		"--text": "#F6EFF3",
		"--text-soft": "#A78E9B",
		"--muted": "#76616B",
		"--accent": "#F43888",
		"--accent-dim": "rgb(244 56 136 / 0.12)",
		"--ok": "#B4E7C7",
		"--warn": "#F2B86D",
		"--error": "#FF718F",
	});
});

test("a theme that leaves a colour out leaves the app's own value standing", () => {
	const sparse = cssVariablesOf({ name: "Sparse", tokens: { text: "#ABCDEF", accent: "#123456" } });
	assert.equal(sparse?.["--text"], "#ABCDEF");
	assert.equal(sparse?.["--surface-2"], undefined);
	assert.equal(sparse?.["--surface-3"], undefined);
	assert.equal(sparse?.["--bg"], undefined);
	assert.equal(cssVariablesOf({ name: "Empty", tokens: {} }), null);
	assert.equal(cssVariablesOf(null), null);
});

test("system is the OS scheme, so the desktop picks which built-in it means", () => {
	assert.equal(themeNameFor("system", true), "dark");
	assert.equal(themeNameFor("system", false), "light");
	assert.deepEqual(namesToResolve("system"), ["dark", "light"]);
	assert.equal(themeNameFor("Gentleman-Sexy", true), "Gentleman-Sexy");
	assert.deepEqual(namesToResolve("Gentleman-Sexy"), []);
	assert.equal(themeNameFor(null, true), null);
});

test("a name nothing resolved paints nothing, so no half theme is left behind", () => {
	assert.equal(themeNameFor("Retired-Theme", true), "Retired-Theme");
	assert.equal(cssVariablesOf(null), null);
});

test("a value a webview cannot paint is dropped, never guessed at", () => {
	assert.equal(cssValueOf("#F6EFF3"), "#F6EFF3");
	assert.equal(cssValueOf("rgb(1 2 3 / 0.5)"), "rgb(1 2 3 / 0.5)");
	assert.equal(cssValueOf("oklch(0.7 0.1 300)"), "oklch(0.7 0.1 300)");
	assert.equal(cssValueOf("hsl(300 50% 60%)"), "hsl(300 50% 60%)");
	// Pi's own built-in themes are written in okhsl(), which CSS does not have.
	assert.equal(cssValueOf("okhsl(234 3% 89%)"), null);
	assert.equal(cssValueOf("mint"), null);
	assert.equal(cssValueOf("#12345"), null);
	assert.equal(cssValueOf(undefined), null);
	assert.equal(cssVariablesOf(resolved({ text: "okhsl(234 3% 89%)" }))?.["--text"], undefined);
});

function sink(): StyleSink & { readonly kept: Map<string, string> } {
	const kept = new Map<string, string>();
	return {
		kept,
		setProperty: (name, value) => void kept.set(name, value),
		removeProperty: (name) => void kept.delete(name),
	};
}

test("applying a theme replaces the previous one, and clearing it brings the defaults back", () => {
	const style = sink();
	let applied = applyCssVariables(style, cssVariablesOf(resolved()), []);
	assert.equal(style.kept.get("--text"), "#F6EFF3");
	assert.deepEqual(applied, Object.keys(cssVariablesOf(resolved()) ?? {}));

	// A theme that drops a token must not leave the previous theme's value behind.
	applied = applyCssVariables(style, cssVariablesOf({ name: "Sparse", tokens: { text: "#000000" } }), applied);
	assert.equal(style.kept.get("--text"), "#000000");
	assert.equal(style.kept.has("--surface-2"), false);

	applied = applyCssVariables(style, null, applied);
	assert.equal(style.kept.size, 0);
	assert.deepEqual(applied, []);
});
