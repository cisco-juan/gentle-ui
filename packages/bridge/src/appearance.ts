import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AppearanceView,
	ResolvedTheme,
	ThemeCatalogEntry,
	ThemeSource,
} from "@gentle-shell/protocol";
import {
	ConfigWriteError,
	configApply,
	configPreview,
	readConfigFile,
	type ConfigWriteRequest,
} from "./config-write.ts";
import { gentleHomes, resolveExtensionRoot, type GentleOptions } from "./gentle-pi-library.ts";

/**
 * Themes, read from the places Gentle Shell and Pi already keep them, and written through one key.
 *
 * The selected theme is one key of Pi's own `settings.json`. The definitions live in three folders: Pi's
 * built-ins (`dark`, `light`, and the `system` theme it synthesises from the terminal's colours), the
 * themes gentle-pi ships in its package, and the user's `<agent home>/themes`. The last definition of a
 * name wins, so a user theme overrides a shipped one, which overrides a built-in — and a name is always
 * the name the file itself declares, never a prettified version of a file name.
 *
 * Reading only ever reads. A theme file that is not one — no `colors`, no usable name, a folder that is
 * actually a symlink out of the theme root — is left out of the catalog rather than guessed at.
 *
 * Pi's built-in `dark` and `light` are written in `okhsl()`, which no webview paints; the themes gentle-pi
 * ships are plain hex. Every colour a theme resolves to is therefore answered in a notation the desktop can
 * assign as a CSS variable: `okhsl()` is converted to hex here, once, and a value that is neither hex nor a
 * CSS colour function is left out of the tokens instead of being handed on unpaintable.
 *
 * Writing is one key of a file another program owns, so the four rules `config-write.ts` already enforces
 * apply unchanged: the file's own indentation and final newline survive, the bytes the write replaces are
 * kept under the profiles backup folder next to the profiles backups, the write is atomic, and a file that
 * cannot be parsed is never replaced. On top of those, a name that is not in the catalog this bridge just
 * read is refused, so the UI cannot write a theme the machine does not have.
 */

/** Pi's built-in themes, and the name it reserves for the one it generates instead of reading. */
export const BUILTIN_THEME_NAMES: readonly string[] = ["dark", "light"];
export const SYSTEM_THEME_NAME = "system";

/** The `colors` keys a web UI paints. Thinking state and palette-only vars are the terminal's business. */
export const WEB_TOKENS: readonly string[] = [
	"text",
	"muted",
	"dim",
	"accent",
	"borderMuted",
	"success",
	"warning",
	"error",
	"selectedBg",
	"userMessageBg",
];

/** The page and card backgrounds Pi keeps apart, because a terminal has no page of its own. */
const EXPORT_TOKENS: readonly string[] = ["pageBg", "cardBg"];

/** A theme file is small; anything larger is not one, and reading it whole would stall the answer. */
const MAX_THEME_BYTES = 256 * 1024;
const MAX_ROSE_BYTES = 8 * 1024;

export interface ThemeRoots {
	readonly builtin: string | null;
	readonly extension: string | null;
	readonly user: string | null;
}

/** One theme definition found on disk. `system` is the one entry without a file. */
export interface ThemeFile {
	readonly name: string;
	readonly source: ThemeSource;
	readonly path: string | null;
}

export interface AppearanceOptions extends GentleOptions {
	/** The three folders themes live in; a test points this at a scratch tree. */
	readonly themeRoots?: ThemeRoots;
	/** Pi's package root, whose `modes/interactive/theme` holds `dark.json` and `light.json`. */
	readonly piRoot?: string;
	/** Backup timestamps; a test pins them instead of reading the clock. */
	readonly now?: () => Date;
}

// ---- one theme file ----

/**
 * A theme document as a web UI may use it: `colors` resolved against the file's own `vars`.
 *
 * `available` is the catalog the caller just read, and the declared name has to be in it: a file that
 * renames itself does not get to invent a name, and a name is compared exactly. A document without a
 * `colors` map, or one where no colour comes out paintable, is not a theme and answers `null`.
 */
export function resolveTheme(raw: unknown, available: readonly string[]): ResolvedTheme | null {
	if (!isRecord(raw)) return null;
	const name = raw["name"];
	if (typeof name !== "string" || name.length === 0 || name.includes("/") || !available.includes(name)) return null;
	const colors = raw["colors"];
	if (!isRecord(colors)) return null;

	const vars = isRecord(raw["vars"]) ? raw["vars"] : {};
	const exported = isRecord(raw["export"]) ? raw["export"] : {};
	const tokens: Record<string, string> = {};
	for (const token of WEB_TOKENS) putToken(tokens, token, colorOf(colors[token], vars));
	for (const token of EXPORT_TOKENS) putToken(tokens, token, colorOf(exported[token], vars));
	return Object.keys(tokens).length === 0 ? null : { name, tokens };
}

function putToken(tokens: Record<string, string>, token: string, value: string | null): void {
	if (value !== null) tokens[token] = value;
}

/**
 * One colour: a variable name resolves to that variable's value, and the value that comes out is answered in
 * a notation a webview paints.
 *
 * Pi resolves an unknown reference to the reference itself, so this does too — and then hands the value to
 * `paintOf`, because a name that resolved to nothing is not a colour and a webview has no way to paint it.
 * The conversion runs on the fully resolved value, so a variable shared by several tokens is converted once
 * per token that uses it, and never converted twice.
 */
function colorOf(value: unknown, vars: Record<string, unknown>, depth = 0): string | null {
	// A palette index is a terminal colour and has no meaning here.
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text.length === 0) return null;
	if (depth < 4 && Object.hasOwn(vars, text)) return colorOf(vars[text], vars, depth + 1);
	return paintOf(text);
}

// ---- colour notations ----

/** Hex as written: CSS paints all four lengths, so a theme that already wrote hex is carried through. */
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;

/** The colour functions a webview paints as they stand. `okhsl()` is deliberately not one of them. */
const CSS_COLOR_FUNCTION = /^(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(.+\)$/i;

/** One resolved value as CSS can paint it, or null when nothing here can make it paintable. */
function paintOf(text: string): string | null {
	if (HEX_COLOR.test(text) || CSS_COLOR_FUNCTION.test(text)) return text;
	return okhslToHex(text);
}

/** The numeric grammar Pi accepts inside a colour function, which this grammar follows exactly. */
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
const OKHSL = new RegExp(
	`^okhsl\\(\\s*(${NUMBER})(?:deg)?\\s+(${NUMBER})(%)?\\s+(${NUMBER})(%)?\\s*(?:/\\s*(${NUMBER})(%)?\\s*)?\\)$`,
	"i",
);

/**
 * One `okhsl(h s% l% / a)` value as `#rrggbb`, or `#rrggbbaa` when the value carries an alpha.
 *
 * A saturation, lightness or alpha outside 0-1 is not a colour — Pi rejects those too — so it answers null
 * rather than throwing, and only its own token is lost. Anything that is not `okhsl()` at all answers null:
 * a notation this file cannot convert faithfully is left out instead of guessed at.
 */
function okhslToHex(text: string): string | null {
	const match = OKHSL.exec(text);
	if (match === null) return null;
	const [, h = "", s = "", sPercent, l = "", lPercent, alphaText, alphaPercent] = match;
	const saturation = Number.parseFloat(s) / (sPercent === undefined ? 1 : 100);
	const lightness = Number.parseFloat(l) / (lPercent === undefined ? 1 : 100);
	const alpha = alphaText === undefined ? undefined : Number.parseFloat(alphaText) / (alphaPercent === undefined ? 1 : 100);
	if (!inUnit(saturation) || !inUnit(lightness) || (alpha !== undefined && !inUnit(alpha))) return null;
	const [r, g, b] = okhslToRgb(Number.parseFloat(h), saturation, lightness);
	const channel = (value: number) => Math.round(value).toString(16).padStart(2, "0");
	const rgb = `#${channel(r)}${channel(g)}${channel(b)}`;
	return alpha === undefined ? rgb : `${rgb}${channel(alpha * 255)}`;
}

function inUnit(value: number): boolean {
	return Number.isFinite(value) && value >= 0 && value <= 1;
}

// ---- OKHSL to sRGB ----
//
// OKHSL defines saturation against the sRGB gamut at each hue and lightness, so there is no closed form: this
// is a port of the reference implementation Pi itself runs — `@earendil-works/pi-tui`'s `dist/oklab.js`,
// which is Björn Ottosson's own code under the MIT license (https://bottosson.github.io/posts/colorpicker/) —
// kept step for step so a value converts to the same eight-bit hex Pi renders. Pi's package is not a
// dependency of this bridge, so it cannot be imported here; the reference is cited instead.

type Vec3 = readonly [number, number, number];

/** Oklab to cube-root LMS. */
const LAB_TO_LMS: readonly [Vec3, Vec3, Vec3] = [
	[1, 0.3963377773761749, 0.2158037573099136],
	[1, -0.1055613458156586, -0.0638541728258133],
	[1, -0.0894841775298119, -1.2914855480194092],
];

/** Cube-root LMS to linear sRGB. */
const LMS_TO_LINEAR_SRGB: readonly [Vec3, Vec3, Vec3] = [
	[4.0767416360759583, -3.3077115392580629, 0.2309699031821043],
	[-1.2684379732850315, 2.6097573492876882, -0.341319376002657],
	[-0.0041960761386756, -0.7034186179359362, 1.7076146940746117],
];

/** Per sRGB channel: the (a, b) half-plane where that channel clips first, and the saturation fitted there. */
interface SaturationFit {
	readonly plane: readonly [number, number];
	readonly polynomial: readonly [number, number, number, number, number];
}

const SATURATION_FIT: readonly [SaturationFit, SaturationFit, SaturationFit] = [
	{ plane: [-1.8817031, -0.80936501], polynomial: [1.19086277, 1.76576728, 0.59662641, 0.75515197, 0.56771245] },
	{ plane: [1.8144408, -1.19445267], polynomial: [0.73956515, -0.45954404, 0.08285427, 0.12541073, -0.14503204] },
	{ plane: [0.13110758, 1.81333971], polynomial: [1.35733652, -0.00915799, -1.1513021, -0.50559606, 0.00692167] },
];

const K1 = 0.206;
const K2 = 0.03;
const K3 = (1 + K1) / (1 + K2);

/** `matrix · vector`, for the 3x3 matrices above. */
function applyMatrix(matrix: readonly [Vec3, Vec3, Vec3], [x, y, z]: Vec3): Vec3 {
	const row = ([first, second, third]: Vec3) => first * x + second * y + third * z;
	return [row(matrix[0]), row(matrix[1]), row(matrix[2])];
}

function dot3([first, second, third]: Vec3, values: Vec3): number {
	return first * values[0] + second * values[1] + third * values[2];
}

/** sRGB transfer function: linear to encoded channel, both 0-1. */
const linearToSrgb = (value: number): number => (value > 0.0031308 ? 1.055 * value ** (1 / 2.4) - 0.055 : 12.92 * value);

/** Oklab [L, a, b] to linear sRGB [r, g, b] (0-1, may leave the gamut). */
function oklabToLinearSrgb([l, a, b]: Vec3): Vec3 {
	const [first, second, third] = applyMatrix(LAB_TO_LMS, [l, a, b]);
	return applyMatrix(LMS_TO_LINEAR_SRGB, [first ** 3, second ** 3, third ** 3]);
}

/** Linear sRGB [r, g, b] to sRGB channels (0-255, rounded), clipping out-of-gamut channels. */
function linearSrgbToRgb(linear: Vec3): Vec3 {
	const channel = (value: number) => Math.round(Math.min(1, Math.max(0, linearToSrgb(value))) * 255);
	return [channel(linear[0]), channel(linear[1]), channel(linear[2])];
}

/** Rate of change of each cube-root LMS component along a chroma direction (a, b). */
function lmsSlopes(a: number, b: number): Vec3 {
	const slope = ([, channelA, channelB]: Vec3) => channelA * a + channelB * b;
	return [slope(LAB_TO_LMS[0]), slope(LAB_TO_LMS[1]), slope(LAB_TO_LMS[2])];
}

/** Largest saturation (C/L) inside sRGB for hue (a, b): the polynomial fit plus one Halley step. */
function maxSaturation(a: number, b: number): number {
	const found = SATURATION_FIT.findIndex((entry, index) => index === 2 || entry.plane[0] * a + entry.plane[1] * b > 1);
	// The blue channel is Pi's own default, and a fixed three-entry list never misses.
	const channel = found === 0 ? 0 : found === 1 ? 1 : 2;
	const { polynomial } = SATURATION_FIT[channel];
	const weights = LMS_TO_LINEAR_SRGB[channel];
	const [k0, k1, k2, k3, k4] = polynomial;
	const saturation = k0 + k1 * a + k2 * b + k3 * a * a + k4 * a * b;
	const slopes = lmsSlopes(a, b);
	const base: Vec3 = [1 + saturation * slopes[0], 1 + saturation * slopes[1], 1 + saturation * slopes[2]];
	const f = dot3(weights, [base[0] ** 3, base[1] ** 3, base[2] ** 3]);
	const f1 = dot3(weights, [3 * slopes[0] * base[0] ** 2, 3 * slopes[1] * base[1] ** 2, 3 * slopes[2] * base[2] ** 2]);
	const f2 = dot3(weights, [6 * slopes[0] ** 2 * base[0], 6 * slopes[1] ** 2 * base[1], 6 * slopes[2] ** 2 * base[2]]);
	return saturation - (f * f1) / (f1 * f1 - 0.5 * f * f2);
}

/** Oklab lightness and chroma of the most saturated sRGB colour of hue (a, b). */
function cusp(a: number, b: number): readonly [number, number] {
	const saturation = maxSaturation(a, b);
	const lightness = Math.cbrt(1 / Math.max(...oklabToLinearSrgb([1, saturation * a, saturation * b])));
	return [lightness, lightness * saturation];
}

/** Chroma where the constant-lightness line at `lightness` leaves the sRGB gamut. */
function maxChroma(a: number, b: number, lightness: number, [cuspLightness, cuspChroma]: readonly [number, number]): number {
	if (lightness <= cuspLightness) return (cuspChroma * lightness) / cuspLightness;
	// Upper half: the triangle edge, then one Halley step against each channel reaching 1.
	const t = (cuspChroma * (lightness - 1)) / (cuspLightness - 1);
	const slopes = lmsSlopes(a, b);
	const lms: Vec3 = [lightness + t * slopes[0], lightness + t * slopes[1], lightness + t * slopes[2]];
	const cubes: Vec3 = [lms[0] ** 3, lms[1] ** 3, lms[2] ** 3];
	const first: Vec3 = [3 * slopes[0] * lms[0] ** 2, 3 * slopes[1] * lms[1] ** 2, 3 * slopes[2] * lms[2] ** 2];
	const second: Vec3 = [6 * slopes[0] ** 2 * lms[0], 6 * slopes[1] ** 2 * lms[1], 6 * slopes[2] ** 2 * lms[2]];
	const steps = LMS_TO_LINEAR_SRGB.map((weights) => {
		const f = dot3(weights, cubes) - 1;
		const f1 = dot3(weights, first);
		const f2 = dot3(weights, second);
		const u = f1 / (f1 * f1 - 0.5 * f * f2);
		return u >= 0 ? -f * u : Number.MAX_VALUE;
	});
	return t + Math.min(...steps);
}

/** OKHSL's chroma reference points at lightness L and hue (a, b): `[c0, cMid, cMax]`. */
function chromaStops(L: number, a: number, b: number): readonly [number, number, number] {
	const peak = cusp(a, b);
	const cMax = maxChroma(a, b, L, peak);
	const k = cMax / Math.min(L * (peak[1] / peak[0]), (1 - L) * (peak[1] / (1 - peak[0])));
	const midS =
		0.11516993 +
		1 /
			(7.4477897 +
				4.1590124 * b +
				a * (-2.19557347 + 1.75198401 * b + a * (-2.13704948 - 10.02301043 * b + a * (-4.24894561 + 5.38770819 * b + 4.69891013 * a))));
	const midT =
		0.11239642 +
		1 /
			(1.6132032 -
				0.68124379 * b +
				a * (0.40370612 + 0.90148123 * b + a * (-0.27087943 + 0.6122399 * b + a * (0.00299215 - 0.45399568 * b - 0.14661872 * a))));
	const cMid = 0.9 * k * Math.sqrt(Math.sqrt(1 / (1 / (L * midS) ** 4 + 1 / ((1 - L) * midT) ** 4)));
	const c0 = Math.sqrt(1 / (1 / (L * 0.4) ** 2 + 1 / ((1 - L) * 0.8) ** 2));
	return [c0, cMid, cMax];
}

/**
 * OKHSL to sRGB channels (0-255, rounded), clipping out-of-gamut channels.
 *
 * @param hue Hue in degrees.
 * @param saturation Saturation, 0-1.
 * @param lightness Lightness, 0-1.
 */
function okhslToRgb(hue: number, saturation: number, lightness: number): Vec3 {
	const L = (lightness * lightness + K1 * lightness) / (K3 * (lightness + K2));
	let lab: Vec3 = [L, 0, 0];
	if (L > 0 && L < 1 && saturation > 0) {
		const angle = (2 * Math.PI * (((hue % 360) + 360) % 360)) / 360;
		const a = Math.cos(angle);
		const b = Math.sin(angle);
		const [c0, cMid, cMax] = chromaStops(L, a, b);
		// Chroma rises from 0 through cMid at s = 0.8 to cMax at s = 1.
		let chroma: number;
		if (saturation < 0.8) {
			const t = 1.25 * saturation;
			const k1 = 0.8 * c0;
			chroma = (t * k1) / (1 - (1 - k1 / cMid) * t);
		} else {
			const t = 5 * (saturation - 0.8);
			const k1 = (0.2 * cMid ** 2 * 1.25 ** 2) / c0;
			chroma = cMid + (t * k1) / (1 - (1 - k1 / (cMax - cMid)) * t);
		}
		lab = [L, chroma * a, chroma * b];
	}
	return linearSrgbToRgb(oklabToLinearSrgb(lab));
}

// ---- the catalog ----

/** Merge what the three places hold. A later definition of a name wins; `system` is listed first. */
export function catalogOf(files: readonly ThemeFile[]): readonly ThemeCatalogEntry[] {
	const merged = new Map<string, ThemeSource>();
	for (const file of files) merged.set(file.name, file.source);
	return [...merged.entries()]
		.map(([name, source]) => ({ name, source }))
		.sort((left, right) => {
			if (left.name === right.name) return 0;
			if (left.name === SYSTEM_THEME_NAME) return -1;
			if (right.name === SYSTEM_THEME_NAME) return 1;
			return left.name.localeCompare(right.name);
		});
}

/** The three theme folders, or null for a source this machine does not have. */
export function themeRoots(options: AppearanceOptions = {}): ThemeRoots {
	if (options.themeRoots !== undefined) return options.themeRoots;
	const { agentHome } = gentleHomes(options);
	return {
		builtin: attempt(() => join(options.piRoot ?? piRoot(), "modes", "interactive", "theme")),
		extension: attempt(() => join(resolveExtensionRoot(options), "themes")),
		user: join(agentHome, "themes"),
	};
}

/** Every theme definition on this machine: `system`, Pi's two files, gentle-pi's themes, the user's. */
export function themeFiles(options: AppearanceOptions = {}): readonly ThemeFile[] {
	const roots = themeRoots(options);
	const files: ThemeFile[] = [{ name: SYSTEM_THEME_NAME, source: "builtin", path: null }];
	for (const name of BUILTIN_THEME_NAMES) {
		const path = confine(roots.builtin, `${name}.json`);
		if (path !== null) files.push({ name, source: "builtin", path });
	}
	for (const [source, root] of [
		["gentle-pi", roots.extension],
		["user", roots.user],
	] as const) {
		for (const path of jsonUnder(root)) {
			const name = declaredName(path);
			if (name !== null) files.push({ name, source, path });
		}
	}
	return files;
}

/** The theme one name resolves to, or null when it has no file this machine may read. */
export function themeOf(files: readonly ThemeFile[], name: string | null): ResolvedTheme | null {
	if (name === null) return null;
	const file = files.find((entry) => entry.name === name);
	if (file === undefined || file.path === null) return null;
	return resolveTheme(parseJson(readText(file.path, MAX_THEME_BYTES)), catalogOf(files).map((entry) => entry.name));
}

/** The `.json` files of one theme folder, real paths only: a symlink cannot widen the catalog. */
function jsonUnder(root: string | null): readonly string[] {
	if (root === null) return [];
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const paths: string[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".json")) continue;
		const path = confine(root, entry.name);
		if (path !== null) paths.push(path);
	}
	return paths.sort();
}

/** `root` itself is read through its real path, so the confinement below compares real with real. */
function confine(root: string | null, name: string): string | null {
	if (root === null) return null;
	try {
		const base = realpathSync(root);
		const path = realpathSync(join(base, name));
		return path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`) ? path : null;
	} catch {
		return null;
	}
}

/** The name a theme file declares for itself, which is what the catalog lists. */
function declaredName(path: string): string | null {
	const raw = parseJson(readText(path, MAX_THEME_BYTES));
	const name = isRecord(raw) ? raw["name"] : undefined;
	return typeof name === "string" && name.length > 0 && !name.includes("/") ? name : null;
}

// ---- reading ----

/**
 * The selected theme, the catalog, that theme's tokens, and the rose's own two files.
 *
 * `name` asks about one theme instead of the selected one, which is how the UI resolves the two halves of
 * `system`: Pi generates that theme from the terminal's colours, and a desktop has to answer it with the
 * OS scheme instead, so it reads `dark` and `light` and picks.
 */
export async function appearanceRead(options: AppearanceOptions = {}, name?: unknown): Promise<AppearanceView> {
	const { configHome, agentHome } = gentleHomes(options);
	const files = themeFiles(options);
	const available = catalogOf(files);
	const rose = {
		banner: readText(join(configHome, "banner.json"), MAX_ROSE_BYTES),
		animations: readText(join(configHome, "animations.json"), MAX_ROSE_BYTES),
	};

	let current: string | null;
	try {
		const value = readConfigFile(join(agentHome, "settings.json")).value;
		const theme = value?.["theme"];
		current = typeof theme === "string" && theme.length > 0 ? theme : null;
	} catch (error) {
		if (!(error instanceof ConfigWriteError)) throw error;
		return {
			state: "unavailable",
			// Reading a settings file only ever fails on its content, which is `file-invalid`.
			reason: "file-invalid",
			message: error.message,
			theme: { current: null, available, tokens: null },
			rose,
		};
	}

	const wanted = typeof name === "string" && name.length > 0 ? name : current;
	return { state: "ok", reason: null, message: "", theme: { current, available, tokens: themeOf(files, wanted) }, rose };
}

// ---- writing ----

/**
 * Choose a theme: the one key Pi reads, and nothing else.
 *
 * The name is checked against the catalog this call just read, exactly and with no trimming, so a request
 * can only ever select a theme the machine has. Every other key of `settings.json` — the packages, the
 * default model, the permission defaults — is carried through untouched, and the bytes being replaced are
 * kept next to the profiles backups.
 */
export async function appearanceSetTheme(name: unknown, options: AppearanceOptions = {}): Promise<AppearanceView> {
	const { configHome, agentHome } = gentleHomes(options);
	const available = catalogOf(themeFiles(options));
	if (!available.some((entry) => entry.name === name)) {
		throw new Error(
			`${JSON.stringify(name) ?? String(name)} is not a theme this machine has, so nothing was written; the catalog lists ${available.map((entry) => entry.name).join(", ")}.`,
		);
	}
	const chosen = name as string;
	const request: ConfigWriteRequest = {
		operation: "appearance.theme",
		// The same backup folder the profiles family uses: one place for what this bridge replaced.
		family: "profiles",
		path: join(agentHome, "settings.json"),
		change: (current) => ({
			next: { ...(current.value ?? {}), theme: chosen },
			summary: [`appearance: select the theme "${chosen}"`],
		}),
	};
	// A target that cannot be parsed is never replaced: `configPreview` refuses it with its own message.
	const preview = await configPreview(request);
	await configApply(request, preview.digest, { configHome, ...(options.now === undefined ? {} : { now: options.now }) });
	return await appearanceRead(options);
}

// ---- small helpers ----

function attempt(resolve: () => string): string | null {
	try {
		return resolve();
	} catch {
		return null;
	}
}

/** The compiled folder of the Pi package this bridge runs against, found as Node finds its own dependency. */
function piRoot(): string {
	return dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
}

/** One file's text, or null when it is missing, unreadable, or too large to be one of these files. */
function readText(path: string, maxBytes: number): string | null {
	try {
		return statSync(path).size > maxBytes ? null : readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function parseJson(text: string | null): unknown {
	if (text === null) return null;
	try {
		return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
