import type { ResolvedTheme } from "@gentle-shell/protocol";

/**
 * A resolved theme, painted by overriding the app's own CSS variables.
 *
 * The shell already has one set of variables in `styles.css`; a theme changes their values and touches no
 * component, so a theme this file has never heard of still looks like this app. Two rules follow:
 *
 * - a token the theme does not carry is not set at all, so that variable keeps the app's own value rather
 *   than receiving a guess;
 * - a value a webview cannot paint — Pi's built-ins are written in `okhsl()`, which CSS does not have — is
 *   dropped the same way instead of being assigned and quietly invalidating the property.
 *
 * `system` is Pi's theme generated from the terminal's colours, and no terminal answers here. The desktop
 * resolves it through the OS colour scheme: it is the built-in `dark` or `light`, which is what the user
 * selected when they asked to follow the system.
 */

/** The app variable each theme token paints, in the order `styles.css` declares them. */
export const TOKEN_VARIABLES: ReadonlyArray<readonly [string, string]> = [
	["--bg", "pageBg"],
	["--rail", "cardBg"],
	["--surface", "cardBg"],
	["--surface-2", "selectedBg"],
	["--surface-3", "userMessageBg"],
	["--hairline", "borderMuted"],
	["--text", "text"],
	["--text-soft", "muted"],
	["--muted", "dim"],
	["--accent", "accent"],
	["--ok", "success"],
	["--warn", "warning"],
	["--error", "error"],
];

/** The name a browser should paint: `system` is the OS scheme, and everything else is itself. */
export function themeNameFor(current: string | null, prefersDark: boolean): string | null {
	if (current === null || current !== "system") return current;
	return prefersDark ? "dark" : "light";
}

/** The names a read has to resolve before the theme can be painted; `system` is the only one with two. */
export function namesToResolve(current: string | null): readonly string[] {
	return current === "system" ? ["dark", "light"] : [];
}

/** One theme's CSS variables, or null when there is nothing paintable in it. */
export function cssVariablesOf(theme: ResolvedTheme | null): Readonly<Record<string, string>> | null {
	if (theme === null) return null;
	const variables: Record<string, string> = {};
	for (const [variable, token] of TOKEN_VARIABLES) {
		const value = cssValueOf(theme.tokens[token]);
		if (value !== null) variables[variable] = value;
	}
	const dim = variables["--accent"] === undefined ? null : translucent(variables["--accent"]);
	if (dim !== null) variables["--accent-dim"] = dim;
	return Object.keys(variables).length === 0 ? null : variables;
}

/** A colour value CSS understands. Pi's own `okhsl()` is deliberately not one of them. */
export function cssValueOf(value: string | undefined): string | null {
	const text = value?.trim() ?? "";
	if (text.length === 0) return null;
	if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) return text;
	if (/^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.+\)$/i.test(text)) return text;
	return null;
}

/** `--accent-dim` is the accent at 12%, which is how the app tints a selected row. */
function translucent(accent: string): string | null {
	const rgb = hexRgb(accent);
	return rgb === null ? null : `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / 0.12)`;
}

function hexRgb(value: string): readonly [number, number, number] | null {
	const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
	if (match === null) return null;
	const digits = match[1] ?? "";
	const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits;
	return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16)) as unknown as readonly [number, number, number];
}

/** The two things this needs from a style object, so the applying can be tested without a window. */
export interface StyleSink {
	setProperty(name: string, value: string): void;
	removeProperty(name: string): void;
}

/**
 * Paint a theme, and un-paint the previous one.
 *
 * Every variable the last theme set is removed first: a theme that lacks a token, or no theme at all, has
 * to bring the app's own default back rather than inherit a value from the theme before it. Returns the
 * variables now set, which is what the next call removes.
 */
export function applyCssVariables(
	sink: StyleSink,
	variables: Readonly<Record<string, string>> | null,
	applied: readonly string[],
): readonly string[] {
	for (const name of applied) sink.removeProperty(name);
	if (variables === null) return [];
	const names = Object.keys(variables);
	for (const name of names) {
		const value = variables[name];
		if (value !== undefined) sink.setProperty(name, value);
	}
	return names;
}
