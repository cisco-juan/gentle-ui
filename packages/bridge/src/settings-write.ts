import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	ConfigFailureReason,
	ConfigPlanView,
	SettingsKeyChange,
	SettingsKeyValue,
	SettingsKeysView,
	SettingsWritableKey,
} from "@gentle-shell/protocol";
import {
	ConfigWriteError,
	configApply,
	configPreview,
	readConfigFile,
	type ConfigChange,
	type ConfigFileState,
	type ConfigPreviewResult,
	type ConfigWriteRequest,
	type JsonObject,
} from "./config-write.ts";
import { GentlePiLibraryError, gentleHomes, requireFunctions, type GentleOptions } from "./gentle-pi-library.ts";
import { SETTINGS_KEYS } from "./settings.ts";

/**
 * The keys of the agent's `settings.json` a person may edit, and nothing else.
 *
 * This is not a JSON editor. The writable set is exactly what `settings.ts` already reports — it is
 * imported from there, not repeated here, because two lists would drift the day one of them grows — and
 * a key that is not in it is refused with a readable reason before a plan exists. That keeps a write to
 * a key with a credential in it impossible by construction rather than by review.
 *
 * Every value is checked before there is anything to confirm:
 *
 * - `defaultProvider` and `defaultModel` are the two strings Pi stores. Pi's own settings schema
 *   (`core/settings-schema.js`) constrains them to a string and nothing else, so a non-empty string is
 *   the whole rule, and this module does not pretend to know which providers or models exist.
 * - `defaultThinkingLevel` is decided by Pi: the value must satisfy Pi's own `isValidThinkingLevel`
 *   (`cli/args.js`), so the accepted levels are whichever ones the installed Pi accepts, never a list
 *   copied here. Pi does not export that list, only the validator, which is why a refusal says the value
 *   Pi rejected instead of enumerating them; `test/settings-write.test.ts` pins the set for Pi 1.5.0.
 *
 * The write is `config-write.ts`'s, the same foundation the packages and MCP families use: the digest of
 * the plan the confirmation shows, a plan that is spent once, a backup of the bytes it replaces, and an
 * atomic `0600` write. That matters twice over here, because `packages.ts` writes this same file: two
 * backup mechanisms would each keep a backup of the other family's writes, and two digests would make
 * one confirmation cover two different changes. The lock is Pi's own too, so a terminal and this bridge
 * cannot interleave their read and their write of `settings.json`.
 *
 * What a write keeps is the file's own shape: every other key and its position, the indentation already
 * on disk, and the final newline it already had. Only the named key's value changes. A file Pi cannot
 * parse is `unavailable` with the reason and is never replaced (C2), and an unset key is not written:
 * this family sets a key, it does not remove one.
 */

/** The names this module calls. A Pi that lacks one is reported by name, not guessed around. */
const REQUIRED = ["isValidThinkingLevel", "FileSettingsStorage"] as const;

/** The family name: the message kind's writer, and the folder this family's backups live in. */
const FAMILY = "settings";

/** The one operation here: a key is set to a value the confirmation showed. There is no unset. */
const OPERATION = "set";

export interface SettingsWriteOptions extends GentleOptions {
	/** Load Pi's library some other way; a test points this at a stand-in. */
	readonly loadLibrary?: (root: string) => Promise<unknown>;
	/** Backup timestamps; a test pins them instead of reading the clock. */
	readonly now?: () => Date;
}

/** What `preview` and `apply` are asked for, straight off the wire and therefore unchecked. */
export interface SettingsKeyRequestInput {
	readonly key: unknown;
	readonly value: unknown;
}

// ---- Pi's own modules ----

interface SettingsStorageLike {
	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void;
}

/** The part of Pi's library this module uses: the level rule, and the lock on the file that holds it. */
export interface SettingsWriteLibrary {
	/** Pi's own rule for a thinking level; the only thing that decides which levels a write accepts. */
	isValidThinkingLevel(level: string): boolean;
	readonly FileSettingsStorage: new (cwd: string, agentDir: string) => SettingsStorageLike;
}

const loaded = new Map<string, Promise<SettingsWriteLibrary>>();

/**
 * Load Pi's argument rules and settings storage from `root`.
 *
 * `isValidThinkingLevel` is `cli/args.js` and `FileSettingsStorage` is `core/settings-manager.js`; the
 * package's `exports` map blocks a deep import, so both are imported by absolute path, the way
 * `settings.ts`, `mcp.ts` and `packages.ts` already load Pi's own code.
 */
export function loadSettingsWriteLibrary(root: string): Promise<SettingsWriteLibrary> {
	const cached = loaded.get(root);
	if (cached !== undefined) return cached;
	const pending = readModules(root);
	// A failed load is not remembered: fixing the install must not need a bridge restart.
	pending.catch(() => loaded.delete(root));
	loaded.set(root, pending);
	return pending;
}

async function readModules(root: string): Promise<SettingsWriteLibrary> {
	const files = [join(root, "cli", "args.js"), join(root, "core", "settings-manager.js")];
	const missing = files.find((file) => !existsSync(file));
	if (missing !== undefined) throw new GentlePiLibraryError("library-missing", `the Pi package is missing ${missing}.`);

	let modules: Record<string, unknown>;
	try {
		modules = Object.assign(
			{},
			...((await Promise.all(files.map((file) => import(pathToFileURL(file).href)))) as Record<string, unknown>[]),
		);
	} catch (error) {
		throw new GentlePiLibraryError("library-incompatible", `the Pi package could not be loaded (${messageOf(error)}).`);
	}
	try {
		return requireFunctions<SettingsWriteLibrary>(modules, REQUIRED, "settings library");
	} catch (error) {
		if (error instanceof GentlePiLibraryError) {
			// The shared check phrases its failure as gentle-pi's; these modules belong to Pi.
			throw new GentlePiLibraryError(
				error.reason,
				error.message.replace("gentle-pi's settings library", "the installed Pi's settings library"),
			);
		}
		throw error;
	}
}

/** The compiled library folder of the Pi package this bridge runs against, found as Node finds its own dependency. */
function piRoot(): string {
	try {
		// `require.resolve` cannot find this package: its manifest declares an ESM entry only.
		return dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	} catch (error) {
		throw new GentlePiLibraryError("library-missing", `the Pi package could not be found (${messageOf(error)}).`);
	}
}

async function library(options: SettingsWriteOptions): Promise<SettingsWriteLibrary> {
	if (options.loadLibrary !== undefined) {
		return requireFunctions<SettingsWriteLibrary>(
			(await options.loadLibrary(piRoot())) as Record<string, unknown>,
			REQUIRED,
			"settings library",
		);
	}
	return await loadSettingsWriteLibrary(piRoot());
}

// ---- preview ----

/**
 * The plan a `set` would perform, with the digest the confirmation carries.
 *
 * Nothing is written, and nothing is even planned until the key and the value have been accepted: an
 * unknown key or a value Pi would not store is refused here, not turned into a plan to regret.
 */
export async function settingsWritePreview(
	workspace: string,
	input: SettingsKeyRequestInput,
	options: SettingsWriteOptions = {},
): Promise<SettingsKeysView> {
	const { agentHome } = gentleHomes(options);
	const path = join(agentHome, "settings.json");

	let lib: SettingsWriteLibrary;
	try {
		lib = await library(options);
	} catch (error) {
		if (error instanceof GentlePiLibraryError) return unavailable(path, existsSync(path), error.reason, error.message);
		throw error;
	}

	const request = requestOf(lib, input);
	try {
		const preview = await configPreview(writeRequest(lib, request, workspace, agentHome, path));
		return viewOf(preview, path, null, request);
	} catch (error) {
		if (error instanceof ConfigWriteError) return refusedOrUnavailable(error, path);
		throw error;
	}
}

// ---- apply ----

/** Perform exactly the plan the confirmation showed, or say why it was refused. */
export async function settingsWriteApply(
	workspace: string,
	input: SettingsKeyRequestInput,
	digest: unknown,
	options: SettingsWriteOptions = {},
): Promise<SettingsKeysView> {
	const { agentHome, configHome } = gentleHomes(options);
	const path = join(agentHome, "settings.json");

	let lib: SettingsWriteLibrary;
	try {
		lib = await library(options);
	} catch (error) {
		if (error instanceof GentlePiLibraryError) return unavailable(path, existsSync(path), error.reason, error.message);
		throw error;
	}

	const request = requestOf(lib, input);
	try {
		// A missing digest is a caller mistake, so it stays an error; a digest that no longer describes
		// this plan is a refusal the panel renders.
		const applied = await configApply(writeRequest(lib, request, workspace, agentHome, path), digest, {
			configHome,
			...(options.now === undefined ? {} : { now: options.now }),
		});
		return viewOf(applied, path, applied, request);
	} catch (error) {
		if (error instanceof ConfigWriteError) return refusedOrUnavailable(error, path);
		throw error;
	}
}

// ---- the request, off the wire ----

interface SettingsKeyRequest {
	readonly key: SettingsWritableKey;
	readonly value: string;
}

/**
 * The one key and value this request names, checked against the writable set and Pi's own rules.
 *
 * The key is compared exactly — no trimming, no case folding — because `settings.json` is read by Pi by
 * exact name: a key this module "helpfully" normalized would be a key Pi never reads.
 */
function requestOf(lib: SettingsWriteLibrary, input: SettingsKeyRequestInput): SettingsKeyRequest {
	const key = requireKey(input.key);
	return { key, value: requireValue(lib, key, input.value) };
}

function requireKey(key: unknown): SettingsWritableKey {
	const known = (SETTINGS_KEYS as readonly unknown[]).find((candidate) => candidate === key);
	if (known === undefined) {
		throw new Error(
			`${shown(key)} is not a settings key this can write; use ${SETTINGS_KEYS.join(", ")}. Nothing was written.`,
		);
	}
	return known as SettingsWritableKey;
}

/** The value a key accepts: a non-empty string, or, for the thinking level, whatever Pi's validator accepts. */
function requireValue(lib: SettingsWriteLibrary, key: SettingsWritableKey, value: unknown): string {
	if (key === "defaultThinkingLevel") {
		if (typeof value === "string" && lib.isValidThinkingLevel(value)) return value;
		throw new Error(
			`${shown(value)} is not a thinking level Pi accepts, so nothing was written. Pi decides which levels exist; this bridge does not keep a list of its own.`,
		);
	}
	if (typeof value === "string" && value.trim().length > 0) return value;
	throw new Error(`"${key}" takes a non-empty string, so ${shown(value)} was not written.`);
}

// ---- the change ----

function writeRequest(
	lib: SettingsWriteLibrary,
	request: SettingsKeyRequest,
	workspace: string,
	agentHome: string,
	path: string,
): ConfigWriteRequest {
	// The same lock Pi's own writers take on this file, so a terminal and this bridge cannot interleave
	// their read and their write. The callback returns nothing: the file is written here, atomically.
	const storage = new lib.FileSettingsStorage(workspace, agentHome);
	return {
		operation: `${FAMILY}.${OPERATION}`,
		family: FAMILY,
		path,
		lock: (run) => {
			storage.withLock("global", () => {
				run();
				return undefined;
			});
		},
		change: (current) => changeOf(request, path, current),
	};
}

/**
 * The new content of the file: the keys it has, in the order it has them, with one value replaced.
 *
 * Spreading keeps every key this family does not own — including the `packages` list another family
 * writes — and assigning the named key keeps its position when it was already there. `config-write.ts`
 * then serializes with the file's own indentation and final newline, so formatting is never this
 * module's to decide.
 */
function changeOf(request: SettingsKeyRequest, path: string, current: ConfigFileState): ConfigChange {
	const existing = current.value?.[request.key];
	if (existing === request.value) {
		throw new Error(`${path} already sets "${request.key}" to ${shown(request.value)}, so nothing was written.`);
	}

	const next: JsonObject = { ...(current.value ?? {}), [request.key]: request.value };
	return {
		next,
		summary: [
			`settings: set "${request.key}"`,
			`settings: "${request.key}" ${existing === undefined ? "unset" : shown(existing)} → ${shown(request.value)}`,
		],
	};
}

// ---- the view ----

function viewOf(
	preview: ConfigPreviewResult,
	path: string,
	applied: { readonly backup: string | null } | null,
	request: SettingsKeyRequest,
): SettingsKeysView {
	const backup = applied?.backup ?? null;
	return {
		state: "ok",
		reason: null,
		message: "",
		path,
		stored: applied === null ? preview.plan.before !== null : true,
		// After an apply the file holds the plan's content; before one it still holds its own.
		keys: keysOf(applied === null ? textAsObject(preview.plan.before) : preview.next),
		notes: backup === null ? [] : [`the previous ${path} was kept at ${backup}.`],
		plan: planViewOf(preview),
		change: changeOfView(preview, request),
		backup,
	};
}

function changeOfView(preview: ConfigPreviewResult, request: SettingsKeyRequest): SettingsKeyChange {
	const before = valueIn(textAsObject(preview.plan.before), request.key);
	return { key: request.key, before, after: request.value };
}

function planViewOf(preview: ConfigPreviewResult): ConfigPlanView {
	return {
		operation: preview.plan.operation,
		target: preview.plan.target,
		digest: preview.digest,
		summary: preview.summary,
	};
}

function refusedOrUnavailable(error: ConfigWriteError, path: string): SettingsKeysView {
	const refused = error.reason === "stale-plan" || error.reason === "changed-on-disk";
	return {
		state: refused ? "refused" : "unavailable",
		reason: error.reason,
		message: error.message,
		path,
		stored: existsSync(path),
		keys: refused ? keysOf(textAsObject(readTextOrNull(path))) : [],
		notes: [],
		plan: null,
		change: null,
		backup: null,
	};
}

function unavailable(path: string, stored: boolean, reason: ConfigFailureReason, message: string): SettingsKeysView {
	return { state: "unavailable", reason, message, path, stored, keys: [], notes: [], plan: null, change: null, backup: null };
}

// ---- projection ----

/** The writable keys as the file holds them: the same rule `settings.ts` reports them with. */
function keysOf(value: JsonObject | null): SettingsKeyValue[] {
	return SETTINGS_KEYS.map((key) => {
		const stored = value?.[key];
		if (typeof stored === "string" || typeof stored === "number" || typeof stored === "boolean") return { key, value: stored };
		return { key, value: null };
	});
}

/** One key's value when it is a string, since a key this family writes is only ever a string. */
function valueIn(value: JsonObject | null, key: string): string | null {
	const stored = value?.[key];
	return typeof stored === "string" ? stored : null;
}

/** A parsed file, or null when it is missing or does not hold a JSON object; used for reporting only. */
function textAsObject(text: string | null): JsonObject | null {
	if (text === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
	} catch {
		return null;
	}
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
}

function readTextOrNull(path: string): string | null {
	try {
		return readConfigFile(path).text;
	} catch {
		return null;
	}
}

// ---- small helpers ----

/** A value as a message may quote it: JSON for anything JSON, and never a bare `undefined`. */
function shown(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
