import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ProfileEffective,
	ProfileMode,
	ProfileOrchestrator,
	ProfileRoute,
	ProfilesActivation,
	ProfilesFailureReason,
	ProfilesView,
	ProfileView,
} from "@gentle-shell/protocol";
import {
	GentlePiLibraryError,
	gentleHomes,
	importModules,
	requireFunctions,
	resolveExtensionRoot,
	type GentleOptions,
} from "./gentle-pi-library.ts";

/**
 * Agent-model profiles, read and written with gentle-pi's own library.
 *
 * `<config home>/profiles.json` belongs to gentle-pi, and so does the rule for what a valid file is:
 * names, model ids, thinking levels, the `workflow` side map, and the way a stale `active` is dropped on
 * read. Re-implementing that here would fork the format the day gentle-pi changes it, so this module
 * loads `lib/agent-profiles.ts` (and the three it needs) from the installed package and calls it. Node
 * will not strip types from files under `node_modules`, so they are loaded with `jiti`, which Pi ships
 * for exactly this job.
 *
 * Two rules follow from the file being someone else's:
 * - nothing is written that gentle-pi's reader would drop. Its reader discards what it does not
 *   recognise without a word, so a value it would drop is refused here with a reason instead;
 * - a file it does not accept is never overwritten. Reading it is reported as `unavailable`, and a
 *   change is refused, so a half-edited file is left for its owner to fix.
 *
 * Before a write the file is backed up whenever it is not exactly what this run last wrote, so the first
 * write keeps the original and a change made by the terminal in between is kept too, while consecutive
 * writes of its own pile up nothing. Backups sit in their own folder, apart from the snapshots gentle-ai
 * keeps in `backups/`. Every write goes through gentle-pi's atomic temp-file-and-rename. There is no lock:
 * the terminal and this bridge can both edit the file, and the last writer wins, exactly as it does
 * between two terminals.
 */

/** The names this module calls. A library that lacks one is reported by name, not guessed around. */
const REQUIRED = [
	"applyOrchestratorSettings",
	"createProfile",
	"deleteProfile",
	"duplicateProfile",
	"emptyProfilesFile",
	"evaluateProfilePin",
	"isOrchestratorMode",
	"isSafeAgentName",
	"isServiceTier",
	"isThinkingLevel",
	"normalizeModelId",
	"parseOrchestratorModelRef",
	"parseProfilesFileText",
	"profilesFilePath",
	"readProfilePinStatus",
	"readProfilesFileResult",
	"readProfileWorkflow",
	"renameProfile",
	"restoreOrchestratorSettings",
	"setActiveProfile",
	"setProfileOrchestratorMode",
	"updateProfile",
	"writeProfilesFileSync",
] as const;

const ORCHESTRATOR = "orchestrator";

/** gentle-pi's agent-name rule lets these through, and as object keys they never become a route. */
const FORBIDDEN_AGENTS = new Set(["__proto__", "constructor", "prototype"]);

interface RoutingEntry {
	model?: string;
	thinking?: string;
	tier?: string;
}

type ModelConfig = Record<string, RoutingEntry>;

interface ProfilesFile {
	kind: string;
	version: number;
	active?: string | undefined;
	profiles: Record<string, ModelConfig>;
	workflow?: Record<string, { orchestratorMode: string }>;
}

interface Drops {
	droppedProfiles: string[];
	droppedAgents: Array<{ profile: string; agent: string }>;
	droppedActive?: string;
	droppedWorkflow?: Array<{ profile: string; mode: string }>;
}

type ReadResult = { status: "missing" } | { status: "invalid" } | { status: "valid"; file: ProfilesFile; drops: Drops };

interface PinLayer {
	source: "local" | "repo";
	profile: string;
	path: string;
}

/** The part of gentle-pi's profile library this module uses. */
export interface ProfilesLibrary {
	applyOrchestratorSettings(
		path: string,
		entry: RoutingEntry,
	): { status: "invalid"; reason: string } | { status: "unchanged" } | { status: "written"; previous?: string };
	createProfile(file: ProfilesFile, name: string, config: ModelConfig): ProfilesFile;
	deleteProfile(file: ProfilesFile, name: string): ProfilesFile;
	duplicateProfile(file: ProfilesFile, from: string, to: string): ProfilesFile;
	emptyProfilesFile(): ProfilesFile;
	evaluateProfilePin(
		status: unknown,
		profiles: Record<string, unknown>,
	): { winner?: PinLayer; invalid: unknown[]; stale: Array<PinLayer> };
	isOrchestratorMode(value: unknown): boolean;
	isSafeAgentName(name: string): boolean;
	isServiceTier(value: unknown): boolean;
	isThinkingLevel(value: unknown): boolean;
	normalizeModelId(value: unknown): string | undefined;
	parseOrchestratorModelRef(modelId: unknown): { provider: string; model: string } | undefined;
	parseProfilesFileText(text: string): { status: "invalid" } | { status: "valid"; file: ProfilesFile };
	profilesFilePath(configHome: string): string;
	readProfilePinStatus(cwd: string): unknown;
	readProfilesFileResult(path: string): ReadResult;
	readProfileWorkflow(file: ProfilesFile, name: string): { orchestratorMode: string };
	renameProfile(file: ProfilesFile, from: string, to: string): ProfilesFile;
	restoreOrchestratorSettings(path: string, previous: string | undefined): void;
	setActiveProfile(file: ProfilesFile, name: string): ProfilesFile;
	setProfileOrchestratorMode(file: ProfilesFile, name: string, mode: string): ProfilesFile;
	updateProfile(file: ProfilesFile, name: string, config: ModelConfig): ProfilesFile;
	writeProfilesFileSync(path: string, file: ProfilesFile): void;
}

export interface ProfilesOptions extends GentleOptions {
	/** Load the library some other way; a test points this at a stand-in. */
	readonly loadLibrary?: (root: string) => Promise<unknown>;
	readonly now?: () => Date;
}

/** A failure the panel can name, so `unavailable` always carries a reason and never an empty list. */
export class ProfilesError extends Error {
	readonly reason: ProfilesFailureReason;

	constructor(reason: ProfilesFailureReason, message: string) {
		super(message);
		this.name = "ProfilesError";
		this.reason = reason;
	}
}

// ---- loading the library ----

const loaded = new Map<string, Promise<ProfilesLibrary>>();

/** Load gentle-pi's profile modules from `root` and check they offer what this module calls. */
export function loadProfilesLibrary(root: string): Promise<ProfilesLibrary> {
	const cached = loaded.get(root);
	if (cached !== undefined) return cached;
	const pending = importModules(root, ["agent-profiles", "profiles-orchestrator", "model-routing-authority", "agent-profile-pin"])
		.then((modules) => requireFunctions<ProfilesLibrary>(modules, REQUIRED, "profile library"))
		.catch((error: unknown) => {
			throw translated(error);
		});
	// A failed load is not remembered: installing or fixing gentle-pi must not need a bridge restart.
	pending.catch(() => loaded.delete(root));
	loaded.set(root, pending);
	return pending;
}

async function library(options: ProfilesOptions): Promise<ProfilesLibrary> {
	try {
		if (options.loadLibrary !== undefined) {
			return requireFunctions<ProfilesLibrary>(await options.loadLibrary(options.extension ?? ""), REQUIRED, "profile library");
		}
		return await loadProfilesLibrary(resolveExtensionRoot(options));
	} catch (error) {
		throw translated(error);
	}
}

/** The shared loader names its failures its own way; the panel knows them as profiles failures. */
function translated(error: unknown): unknown {
	return error instanceof GentlePiLibraryError ? new ProfilesError(error.reason, error.message) : error;
}

// ---- reading ----

/** Every profile with its routes, the active one, and what a new thread in `workspace` would start with. */
export async function profilesList(workspace: string, options: ProfilesOptions = {}): Promise<ProfilesView> {
	const { configHome } = gentleHomes(options);
	let lib: ProfilesLibrary;
	try {
		lib = await library(options);
	} catch (error) {
		if (error instanceof ProfilesError) return unavailable(configHome, error.reason, error.message);
		throw error;
	}

	const path = lib.profilesFilePath(configHome);
	const read = lib.readProfilesFileResult(path);
	if (read.status === "invalid") {
		return unavailable(configHome, "file-invalid", invalidMessage(path));
	}
	if (read.status === "missing") return viewOf(lib, workspace, configHome, lib.emptyProfilesFile(), null, false, []);
	return viewOf(lib, workspace, configHome, read.file, read.drops, true, silentDrops(path));
}

const KNOWN_TOP_LEVEL = new Set(["kind", "version", "active", "profiles", "workflow"]);
/** `effort` is the old name of `thinking`: gentle-pi converts it, so it is not a loss. */
const KNOWN_ENTRY_FIELDS = new Set(["model", "thinking", "tier", "effort"]);

/**
 * What gentle-pi's reader discards without reporting it: top-level keys it does not know and fields
 * inside a route it does not know. Saving writes the file back without them, so they are named here
 * while there is still time to look at the backup.
 */
function silentDrops(path: string): string[] {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;

	const notes: string[] = [];
	for (const key of Object.keys(record)) {
		if (!KNOWN_TOP_LEVEL.has(key)) notes.push(`"${key}" in profiles.json is not known to gentle-pi and is not kept when profiles are saved.`);
	}
	const profiles = record["profiles"];
	if (typeof profiles === "object" && profiles !== null && !Array.isArray(profiles)) {
		for (const [name, config] of Object.entries(profiles as Record<string, unknown>)) {
			if (typeof config !== "object" || config === null || Array.isArray(config)) continue;
			for (const [agent, entry] of Object.entries(config as Record<string, unknown>)) {
				if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
				for (const field of Object.keys(entry as Record<string, unknown>)) {
					if (!KNOWN_ENTRY_FIELDS.has(field)) {
						notes.push(`"${field}" in "${agent}" of "${name}" is not known to gentle-pi and is not kept when profiles are saved.`);
					}
				}
			}
		}
	}
	return notes;
}

function unavailable(configHome: string, reason: ProfilesFailureReason, message: string): ProfilesView {
	return {
		state: "unavailable",
		reason,
		message,
		configHome,
		stored: false,
		active: null,
		effective: null,
		profiles: [],
		agents: [],
		notes: [],
	};
}

function invalidMessage(path: string): string {
	return `${path} is not a profiles file gentle-pi accepts, so it was left alone. Fix or remove it, then reload.`;
}

function viewOf(
	lib: ProfilesLibrary,
	workspace: string,
	configHome: string,
	file: ProfilesFile,
	drops: Drops | null,
	stored: boolean,
	extraNotes: readonly string[],
): ProfilesView {
	const profiles: ProfileView[] = Object.entries(file.profiles).map(([name, config]) => ({
		name,
		mode: lib.readProfileWorkflow(file, name).orchestratorMode as ProfileMode,
		active: file.active === name,
		routes: routesOf(config),
	}));

	const agents = new Set<string>();
	for (const profile of profiles) for (const entry of profile.routes) agents.add(entry.agent);

	const notes: string[] = [...extraNotes];
	if (drops !== null) {
		for (const name of drops.droppedProfiles) notes.push(`profile "${name}" is not valid and is skipped; the next save removes it.`);
		for (const entry of drops.droppedAgents) notes.push(`"${entry.agent}" in "${entry.profile}" is not valid and is skipped; the next save removes it.`);
		if (drops.droppedActive !== undefined) notes.push(`the default "${drops.droppedActive}" names no profile and is ignored.`);
		for (const entry of drops.droppedWorkflow ?? []) notes.push(`the mode "${entry.mode}" for "${entry.profile}" is not valid and is skipped.`);
	}

	const pin = pinOf(lib, workspace, file, notes);
	const effective: ProfileEffective | null =
		pin !== null
			? { name: pin.profile, source: pin.source === "local" ? "pin-local" : "pin-repo" }
			: file.active !== undefined
				? { name: file.active, source: "active" }
				: null;

	return {
		state: "ok",
		reason: null,
		message: "",
		configHome,
		stored,
		active: file.active ?? null,
		effective,
		profiles,
		agents: [...agents].sort(byAgent),
		notes,
	};
}

/** The pin layer that wins for `workspace`, and a note for each layer that is broken or stale. */
function pinOf(lib: ProfilesLibrary, workspace: string, file: ProfilesFile, notes: string[]): PinLayer | null {
	let evaluation: ReturnType<ProfilesLibrary["evaluateProfilePin"]>;
	try {
		evaluation = lib.evaluateProfilePin(lib.readProfilePinStatus(workspace), file.profiles);
	} catch {
		// A pin that cannot be read must not stop the list: it only means one thing is not shown.
		return null;
	}
	for (const layer of evaluation.stale) notes.push(`the ${layer.source} pin names "${layer.profile}", which no longer exists, so it is ignored.`);
	if (evaluation.invalid.length > 0) notes.push("a pin file here is not a pin gentle-pi understands, so it is ignored.");
	return evaluation.winner ?? null;
}

function routesOf(config: ModelConfig): ProfileRoute[] {
	return Object.entries(config)
		.map(([agent, entry]) => ({
			agent,
			model: entry.model ?? null,
			thinking: entry.thinking ?? null,
			tier: entry.tier ?? null,
		}))
		.sort((left, right) => byAgent(left.agent, right.agent));
}

/** The orchestrator first, because it is the one every profile means, then the rest by name. */
function byAgent(left: string, right: string): number {
	if (left === ORCHESTRATOR) return right === ORCHESTRATOR ? 0 : -1;
	if (right === ORCHESTRATOR) return 1;
	return left.localeCompare(right);
}

// ---- writing ----

/** Replace a profile's routes and mode. The profile must already exist. */
export function profilesSave(
	workspace: string,
	name: string,
	routes: readonly ProfileRoute[],
	mode: ProfileMode,
	options: ProfilesOptions = {},
): Promise<ProfilesView> {
	return mutate(workspace, options, (lib, file) => {
		if (!lib.isOrchestratorMode(mode)) throw new Error(`"${String(mode)}" is not an orchestrator mode`);
		const config = configOf(lib, routes);
		return lib.setProfileOrchestratorMode(lib.updateProfile(file, name, config), name, mode);
	});
}

/** A new profile, empty or copied from `from` (routes and mode). */
export function profilesCreate(
	workspace: string,
	name: string,
	from: string | undefined,
	options: ProfilesOptions = {},
): Promise<ProfilesView> {
	return mutate(workspace, options, (lib, file) =>
		from === undefined ? lib.createProfile(file, name, {}) : lib.duplicateProfile(file, from, name),
	);
}

export function profilesRename(workspace: string, name: string, to: string, options: ProfilesOptions = {}): Promise<ProfilesView> {
	return mutate(workspace, options, (lib, file) => lib.renameProfile(file, name, to));
}

export function profilesDelete(workspace: string, name: string, options: ProfilesOptions = {}): Promise<ProfilesView> {
	return mutate(workspace, options, (lib, file) => lib.deleteProfile(file, name));
}

/**
 * Make a profile the global default and point Pi's own default model at its orchestrator.
 *
 * Pi's settings are written first and the profiles file second, and a failure of the second puts the
 * first back, so the default and the orchestrator never end up describing different profiles. A profile
 * that routes no orchestrator leaves Pi's settings exactly as they were.
 */
export async function profilesActivate(
	workspace: string,
	name: string,
	options: ProfilesOptions = {},
): Promise<ProfilesActivation> {
	const lib = await library(options);
	const { configHome, agentHome } = gentleHomes(options);
	const path = lib.profilesFilePath(configHome);
	const file = readForWrite(lib, path);
	const next = lib.setActiveProfile(file, name);
	const entry = next.profiles[name]?.[ORCHESTRATOR];

	const settingsPath = join(agentHome, "settings.json");
	let previous: { value: string | undefined } | null = null;
	if (entry !== undefined) {
		const applied = lib.applyOrchestratorSettings(settingsPath, entry);
		if (applied.status === "invalid") throw new Error(`Pi's settings could not be updated, so nothing was changed: ${applied.reason}`);
		if (applied.status === "written") previous = { value: applied.previous };
	}

	try {
		commit(lib, path, configHome, options, next);
	} catch (error) {
		if (previous !== null) lib.restoreOrchestratorSettings(settingsPath, previous.value);
		throw error;
	}

	const view = viewOf(lib, workspace, configHome, next, null, true, []);
	const reference = entry?.model === undefined ? undefined : lib.parseOrchestratorModelRef(entry.model);
	const orchestrator: ProfileOrchestrator | null =
		reference === undefined ? null : { provider: reference.provider, model: reference.model, thinking: entry?.thinking ?? null };
	const pinnedTo = view.effective !== null && view.effective.source !== "active" && view.effective.name !== name ? view.effective.name : null;
	return { view, orchestrator, pinnedTo };
}

async function mutate(
	workspace: string,
	options: ProfilesOptions,
	change: (lib: ProfilesLibrary, file: ProfilesFile) => ProfilesFile,
): Promise<ProfilesView> {
	const lib = await library(options);
	const { configHome } = gentleHomes(options);
	const path = lib.profilesFilePath(configHome);
	const next = change(lib, readForWrite(lib, path));
	commit(lib, path, configHome, options, next);
	return viewOf(lib, workspace, configHome, next, null, true, []);
}

/** The file to change: the stored one, an empty one when there is none yet, never a broken one. */
function readForWrite(lib: ProfilesLibrary, path: string): ProfilesFile {
	const read = lib.readProfilesFileResult(path);
	if (read.status === "invalid") throw new Error(invalidMessage(path));
	return read.status === "valid" ? read.file : lib.emptyProfilesFile();
}

/** Turn the editor's rows into a config, refusing what gentle-pi's reader would drop without a word. */
function configOf(lib: ProfilesLibrary, routes: readonly ProfileRoute[]): ModelConfig {
	const config: ModelConfig = {};
	for (const route of routes) {
		if (!lib.isSafeAgentName(route.agent) || FORBIDDEN_AGENTS.has(route.agent)) {
			throw new Error(`the agent name "${route.agent}" is not valid`);
		}
		if (route.model === null && route.thinking === null && route.tier === null) continue;
		if (Object.prototype.hasOwnProperty.call(config, route.agent)) throw new Error(`the agent "${route.agent}" is listed twice`);

		const entry: RoutingEntry = {};
		if (route.model !== null) {
			const model = lib.normalizeModelId(route.model);
			if (model === undefined) throw new Error(`the model id "${route.model}" for "${route.agent}" is not valid`);
			if (route.agent === ORCHESTRATOR && lib.parseOrchestratorModelRef(model) === undefined) {
				throw new Error(`the orchestrator model must be a provider/model pair, not "${model}"`);
			}
			entry.model = model;
		}
		if (route.thinking !== null) {
			if (!lib.isThinkingLevel(route.thinking)) throw new Error(`the thinking level "${route.thinking}" for "${route.agent}" is not valid`);
			entry.thinking = route.thinking;
		}
		if (route.tier !== null) {
			if (!lib.isServiceTier(route.tier)) throw new Error(`the tier "${route.tier}" for "${route.agent}" is not valid`);
			entry.tier = route.tier;
		}
		config[route.agent] = entry;
	}
	return config;
}

/** The text this run last wrote to each file; what is on disk and equal to it needs no backup. */
const lastWritten = new Map<string, string>();

const BACKUP_DIRECTORY = "profiles-backups";

/** Back the file up if needed, write it atomically, and remember what is now on disk. */
function commit(lib: ProfilesLibrary, path: string, configHome: string, options: ProfilesOptions, next: ProfilesFile): void {
	keepBackup(path, configHome, options);
	lib.writeProfilesFileSync(path, next);
	try {
		lastWritten.set(path, readFileSync(path, "utf8"));
	} catch {
		lastWritten.delete(path);
	}
}

/** Keep the bytes about to be replaced, unless they are exactly what this run wrote itself. */
function keepBackup(path: string, configHome: string, options: ProfilesOptions): void {
	if (!existsSync(path)) return;
	if (lastWritten.get(path) === readFileSync(path, "utf8")) return;

	const directory = join(configHome, BACKUP_DIRECTORY);
	mkdirSync(directory, { recursive: true });
	const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
	// Two backups in the same millisecond must not overwrite each other, or fail.
	for (let attempt = 0; ; attempt++) {
		const target = join(directory, `profiles.${stamp}${attempt === 0 ? "" : `-${attempt}`}.json`);
		try {
			copyFileSync(path, target, constants.COPYFILE_EXCL);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 50) throw error;
		}
	}
}
