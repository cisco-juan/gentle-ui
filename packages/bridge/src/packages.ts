import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	ConfigFailureReason,
	ConfigPlanView,
	PackagesChange,
	PackagesOperation,
	PackagesView,
	SettingsPackage,
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

/**
 * The agent's `packages` list, written with Pi's own settings writer.
 *
 * `<agentHome>/settings.json` belongs to Pi, and so do the rules for what a valid file is and how a
 * package source is spelled, compared and normalized. Re-implementing any of that here would fork the
 * format the day Pi changes it, so this module loads Pi's own compiled modules and calls them:
 * `SettingsManager` for the file, `DefaultPackageManager` for the `packages` list, and
 * `FileSettingsStorage.withLock` for the lock Pi's writers take on the same file.
 *
 * Nothing is installed from here, and this module never runs `pi install`. A source written to
 * `settings.json` is resolved and installed by Pi itself when the agent starts, so the whole effect of
 * an edit made in the sheet is one settings entry — which is also why no test here can reach a network.
 *
 * The write itself is delegated to `config-write.ts`, which owns the rules that outlive any one family:
 * the plan and its digest, the confirmation an apply requires, the backup, and the atomic `0600` write.
 * This module contributes the two things only it knows: how the change is made (Pi's package manager,
 * over an in-memory copy of the current file) and how the result is described to the panel.
 *
 * A settings file Pi cannot read is `unavailable` with the reason, and nothing is written over it: the
 * plan refuses, so a half-edited file is left for its owner to repair.
 */

/** The names this module calls. A Pi that lacks one is reported by name, not guessed around. */
const REQUIRED = ["DefaultPackageManager", "FileSettingsStorage", "InMemorySettingsStorage", "SettingsManager"] as const;

/** The family name: the message kind, and the folder this family's backups live in. */
const FAMILY = "packages";

export interface PackagesOptions extends GentleOptions {
	/** Load Pi's library some other way; a test points this at a stand-in package manager. */
	readonly loadLibrary?: (root: string) => Promise<unknown>;
	/** Backup timestamps; a test pins them instead of reading the clock. */
	readonly now?: () => Date;
}

// ---- Pi's own modules ----

/** A `packages` entry as Pi stores it: a bare source, or an object that says what of it to load. */
type PackageEntry = string | { readonly source: string };

interface SettingsStorageLike {
	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void;
}

interface SettingsErrorLike {
	readonly scope: string;
	readonly path?: string;
	readonly error: Error;
}

interface SettingsManagerLike {
	getGlobalSettings(): { readonly packages?: unknown };
	setPackages(packages: PackageEntry[]): void;
	flush(): Promise<void>;
	drainErrors(): SettingsErrorLike[];
}

/** The part of Pi's package manager this module uses: the two settings edits, and nothing that installs. */
interface PackageManagerLike {
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
}

/** The part of Pi's library this module uses. */
export interface PackagesLibrary {
	readonly DefaultPackageManager: new (options: {
		cwd: string;
		agentDir: string;
		settingsManager: SettingsManagerLike;
	}) => PackageManagerLike;
	readonly FileSettingsStorage: new (cwd: string, agentDir: string) => SettingsStorageLike;
	readonly InMemorySettingsStorage: new () => SettingsStorageLike;
	readonly SettingsManager: {
		create(cwd: string, agentDir?: string): SettingsManagerLike;
		fromStorage(storage: SettingsStorageLike, options?: { projectTrusted?: boolean }): SettingsManagerLike;
	};
}

const loaded = new Map<string, Promise<PackagesLibrary>>();

/**
 * Load Pi's settings and package modules from `root`.
 *
 * `SettingsManager` is importable from the package index, but the two storages are not, and the
 * `exports` map blocks a deep import — so the files are imported by absolute path, the way
 * `settings.ts` already loads Pi's skills and MCP modules. They are the same modules the index
 * re-exports, so this is Pi's own implementation, not a copy of it.
 */
export function loadPackagesLibrary(root: string): Promise<PackagesLibrary> {
	const cached = loaded.get(root);
	if (cached !== undefined) return cached;
	const pending = readModules(root);
	// A failed load is not remembered: fixing the install must not need a bridge restart.
	pending.catch(() => loaded.delete(root));
	loaded.set(root, pending);
	return pending;
}

async function readModules(root: string): Promise<PackagesLibrary> {
	const files = [join(root, "core", "settings-manager.js"), join(root, "core", "package-manager.js")];
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
		return requireFunctions<PackagesLibrary>(modules, REQUIRED, "settings library");
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

async function library(options: PackagesOptions): Promise<PackagesLibrary> {
	if (options.loadLibrary !== undefined) {
		return requireFunctions<PackagesLibrary>((await options.loadLibrary(piRoot())) as Record<string, unknown>, REQUIRED, "settings library");
	}
	return await loadPackagesLibrary(piRoot());
}

// ---- reading ----

/** Every package Pi loads from the agent's settings, projected for the panel. Reading never writes. */
export async function packagesList(workspace: string, options: PackagesOptions = {}): Promise<PackagesView> {
	const { agentHome } = gentleHomes(options);
	const path = join(agentHome, "settings.json");

	let lib: PackagesLibrary;
	try {
		lib = await library(options);
	} catch (error) {
		if (error instanceof GentlePiLibraryError) return unavailable(path, existsSync(path), error.reason, error.message);
		throw error;
	}

	let state: ConfigFileState;
	try {
		state = readConfigFile(path);
	} catch (error) {
		if (error instanceof ConfigWriteError) return unavailable(path, existsSync(path), error.reason, error.message);
		throw error;
	}

	// Pi's own reader decides what the file means; its errors are the reason, never a silent empty list.
	let manager: SettingsManagerLike;
	try {
		manager = lib.SettingsManager.create(workspace, agentHome);
	} catch (error) {
		return unavailable(path, state.text !== null, "file-invalid", `${path} could not be read (${messageOf(error)}), so no package is listed.`);
	}
	const errors = loadErrors(manager);
	if (errors.length > 0) return unavailable(path, state.text !== null, "file-invalid", invalidMessage(path, errors));

	const listed = listOf(manager.getGlobalSettings().packages);
	if (listed === null) {
		return unavailable(
			path,
			state.text !== null,
			"file-invalid",
			invalidMessage(path, [{ scope: "global", error: new Error('"packages" is not a list') }]),
		);
	}

	const notes = state.text === null ? [`${path} does not exist yet, so no package is installed.`] : [];
	notes.push(...notesOf(listed, path));
	return {
		state: "ok",
		reason: null,
		message: "",
		path,
		stored: state.text !== null,
		packages: listed.map(packageOf).filter((entry): entry is SettingsPackage => entry !== null),
		notes,
		plan: null,
		change: null,
		backup: null,
	};
}

// ---- preview ----

/**
 * The plan an `install` or a `remove` would perform, with the digest the confirmation carries.
 *
 * Nothing is written: the change is computed on an in-memory copy of the file through Pi's own package
 * manager, so the text the plan shows is the text Pi would write, without a byte reaching the disk.
 */
export async function packagesPreview(
	workspace: string,
	operation: unknown,
	source: unknown,
	options: PackagesOptions = {},
): Promise<PackagesView> {
	const op = operationOf(operation);
	const from = sourceOf(source);
	const { agentHome } = gentleHomes(options);
	const path = join(agentHome, "settings.json");

	let lib: PackagesLibrary;
	try {
		lib = await library(options);
	} catch (error) {
		if (error instanceof GentlePiLibraryError) return unavailable(path, existsSync(path), error.reason, error.message);
		throw error;
	}

	try {
		const preview = await configPreview(writeRequest(lib, workspace, op, from, options, path));
		return viewOf(preview, path, null);
	} catch (error) {
		if (error instanceof ConfigWriteError) return refusedOrUnavailable(error, path);
		throw error;
	}
}

// ---- apply ----

/** Perform exactly the plan the confirmation showed, or say why it was refused. */
export async function packagesApply(
	workspace: string,
	operation: unknown,
	source: unknown,
	digest: unknown,
	options: PackagesOptions = {},
): Promise<PackagesView> {
	const op = operationOf(operation);
	const from = sourceOf(source);
	const { agentHome, configHome } = gentleHomes(options);
	const path = join(agentHome, "settings.json");

	let lib: PackagesLibrary;
	try {
		lib = await library(options);
	} catch (error) {
		if (error instanceof GentlePiLibraryError) return unavailable(path, existsSync(path), error.reason, error.message);
		throw error;
	}

	const request = writeRequest(lib, workspace, op, from, options, path);
	try {
		// A missing digest is a caller mistake, so it stays an error; a digest that no longer describes
		// this plan is a refusal the panel renders.
		const applied = await configApply(request, digest, {
			configHome,
			...(options.now === undefined ? {} : { now: options.now }),
		});
		return viewOf(applied, path, applied);
	} catch (error) {
		if (error instanceof ConfigWriteError) return refusedOrUnavailable(error, path);
		throw error;
	}
}

// ---- the change, made with Pi's own package manager ----

function writeRequest(
	lib: PackagesLibrary,
	workspace: string,
	op: PackagesOperation,
	source: string,
	options: PackagesOptions,
	path: string,
): ConfigWriteRequest {
	const { agentHome } = gentleHomes(options);
	// The same lock Pi's own writers take on this file, so a terminal and this bridge cannot interleave
	// their read and their write. The callback returns nothing: the file is written here, atomically.
	const storage = new lib.FileSettingsStorage(workspace, agentHome);
	return {
		operation: `${FAMILY}.${op}`,
		family: FAMILY,
		path,
		lock: (run) => {
			storage.withLock("global", () => {
				run();
				return undefined;
			});
		},
		change: async (current) => changeOf(lib, op, source, workspace, agentHome, path, current),
	};
}

/**
 * The new content, computed by Pi over an in-memory copy of the file.
 *
 * An in-memory storage is what makes a preview honest: Pi's manager loads the file, replaces only the
 * `packages` field, serializes with its own writer, and no disk is involved until `config-write` decides
 * to write. Keys this family does not own are therefore kept by Pi itself, not by a merge written here.
 */
async function changeOf(
	lib: PackagesLibrary,
	op: PackagesOperation,
	source: string,
	workspace: string,
	agentHome: string,
	path: string,
	current: ConfigFileState,
): Promise<ConfigChange> {
	const storage = new lib.InMemorySettingsStorage();
	if (current.text !== null) storage.withLock("global", () => current.text as string);
	const manager = lib.SettingsManager.fromStorage(storage, { projectTrusted: false });

	const readErrors = loadErrors(manager);
	if (readErrors.length > 0) throw new ConfigWriteError("file-invalid", invalidMessage(path, readErrors));
	const before = listOf(manager.getGlobalSettings().packages);
	if (before === null) {
		throw new ConfigWriteError("file-invalid", invalidMessage(path, [{ scope: "global", error: new Error('"packages" is not a list') }]));
	}

	const packageManager = new lib.DefaultPackageManager({ cwd: workspace, agentDir: agentHome, settingsManager: manager });
	const changed =
		op === "install" ? packageManager.addSourceToSettings(source) : packageManager.removeSourceFromSettings(source);
	if (!changed) {
		throw new Error(
			op === "install"
				? `${path} already lists ${JSON.stringify(source)}, so nothing was written.`
				: `${path} does not list ${JSON.stringify(source)}, so nothing was written.`,
		);
	}

	await manager.flush();
	const writeErrors = loadErrors(manager);
	if (writeErrors.length > 0) throw new ConfigWriteError("file-invalid", invalidMessage(path, writeErrors));

	let text: string | undefined;
	storage.withLock("global", (serialized) => {
		text = serialized;
		return undefined;
	});
	if (text === undefined) throw new ConfigWriteError("file-invalid", `${path} produced no settings for Pi's own writer to hold, so nothing was written.`);

	const next = parseObject(path, text);
	const after = listOf(next["packages"]);
	return {
		next,
		summary: [
			`packages: ${op === "install" ? "add" : "remove"} ${JSON.stringify(source)}`,
			`packages: ${before.length} → ${after?.length ?? 0} entries`,
		],
	};
}

// ---- the view ----

function viewOf(preview: ConfigPreviewResult, path: string, applied: { readonly backup: string | null } | null): PackagesView {
	const before = packagesOfText(preview.plan.before);
	const after = packagesOfText(preview.plan.after);
	const backup = applied?.backup ?? null;
	return {
		state: "ok",
		reason: null,
		message: "",
		path,
		stored: true,
		// After an apply the file holds the plan's content; before one it still holds its own.
		packages: applied === null ? before : after,
		notes: backup === null ? [] : [`the previous ${path} was kept at ${backup}.`],
		plan: planViewOf(preview),
		change: { before, after } satisfies PackagesChange,
		backup,
	};
}

function planViewOf(preview: ConfigPreviewResult): ConfigPlanView {
	return {
		operation: preview.plan.operation,
		target: preview.plan.target,
		digest: preview.digest,
		summary: preview.summary,
	};
}

function refusedOrUnavailable(error: ConfigWriteError, path: string): PackagesView {
	const refused = error.reason === "stale-plan" || error.reason === "changed-on-disk";
	return {
		state: refused ? "refused" : "unavailable",
		reason: error.reason,
		message: error.message,
		path,
		stored: existsSync(path),
		packages: refused ? packagesOfText(readTextOrNull(path)) : [],
		notes: [],
		plan: null,
		change: null,
		backup: null,
	};
}

function unavailable(path: string, stored: boolean, reason: ConfigFailureReason, message: string): PackagesView {
	return { state: "unavailable", reason, message, path, stored, packages: [], notes: [], plan: null, change: null, backup: null };
}

// ---- projection ----

/** Pi keeps a `packages` entry as a bare source or an object; the panel sees one shape. */
function packageOf(entry: PackageEntry): SettingsPackage | null {
	if (typeof entry === "string" && entry.trim().length > 0) {
		return { source: entry, autoload: true, extensions: [], skills: [], prompts: [], themes: [] };
	}
	if (typeof entry !== "object" || entry === null) return null;
	const record = entry as Record<string, unknown>;
	const source = record["source"];
	if (typeof source !== "string" || source.trim().length === 0) return null;
	return {
		source,
		autoload: record["autoload"] !== false,
		extensions: stringsOf(record["extensions"]),
		skills: stringsOf(record["skills"]),
		prompts: stringsOf(record["prompts"]),
		themes: stringsOf(record["themes"]),
	};
}

/** The `packages` a plan's text holds, projected the way the view reports them. */
function packagesOfText(text: string | null): SettingsPackage[] {
	if (text === null) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
	const listed = listOf((parsed as Record<string, unknown>)["packages"]);
	if (listed === null) return [];
	return listed.map(packageOf).filter((entry): entry is SettingsPackage => entry !== null);
}

/** A `packages` value that is a list, or null when it is something Pi would not have written. */
function listOf(raw: unknown): PackageEntry[] | null {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) return null;
	return raw as PackageEntry[];
}

function notesOf(listed: readonly PackageEntry[], path: string): string[] {
	const notes: string[] = [];
	for (const [index, entry] of listed.entries()) {
		if (packageOf(entry) === null) notes.push(`packages[${index}] in ${path} is not a package source, so it is skipped and left alone.`);
	}
	return notes;
}

function parseObject(path: string, text: string): JsonObject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
	} catch (error) {
		throw new ConfigWriteError("file-invalid", `${path} is not a configuration file this can edit, so nothing was written: ${messageOf(error)}.`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ConfigWriteError("file-invalid", `${path} is not a configuration file this can edit, so nothing was written: the file is not a JSON object.`);
	}
	return parsed as JsonObject;
}

function stringsOf(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function loadErrors(manager: SettingsManagerLike): SettingsErrorLike[] {
	try {
		return manager.drainErrors().filter((entry) => entry.scope === "global");
	} catch {
		return [];
	}
}

function invalidMessage(path: string, errors: readonly SettingsErrorLike[]): string {
	const why = errors.map((entry) => entry.error.message).join("; ");
	return `${path} is not a settings file Pi accepts, so it was left alone: ${why}. Fix or remove it, then reload.`;
}

// ---- the wire ----

/** `operation` arrives as unchecked JSON, so it is compared exactly: no trimming, no case folding. */
function operationOf(operation: unknown): PackagesOperation {
	if (operation === "install" || operation === "remove") return operation;
	throw new Error(`${JSON.stringify(operation) ?? String(operation)} is not a package operation this can write; use install or remove.`);
}

function sourceOf(source: unknown): string {
	if (typeof source === "string" && source.trim().length > 0) return source;
	throw new Error("a package source must be a non-empty string");
}

function readTextOrNull(path: string): string | null {
	try {
		return readConfigFile(path).text;
	} catch {
		return null;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
