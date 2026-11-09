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
 * `colors` map, or one where nothing resolves, is not a theme and answers `null`.
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
 * One colour: a variable name resolves to that variable's value, anything else is itself.
 *
 * Pi resolves an unknown reference to the reference itself, so this does too — whether a value is
 * something a webview can paint is the UI's decision, not this file's format.
 */
function colorOf(value: unknown, vars: Record<string, unknown>, depth = 0): string | null {
	// A palette index is a terminal colour and has no meaning here.
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text.length === 0) return null;
	if (depth < 4 && Object.hasOwn(vars, text)) return colorOf(vars[text], vars, depth + 1);
	return text;
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
