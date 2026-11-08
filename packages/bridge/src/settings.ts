import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	SettingsConfigSection,
	SettingsFailureReason,
	SettingsKeyValue,
	SettingsMcpSection,
	SettingsMcpServer,
	SettingsPackage,
	SettingsSecretName,
	SettingsSkill,
	SettingsSkillsSection,
	SettingsView,
} from "@gentle-shell/protocol";
import { GentlePiLibraryError, gentleHomes, requireFunctions, type GentleOptions } from "./gentle-pi-library.ts";
import { redactedArgument, redactedUrl, secretNames } from "./redaction.ts";

/**
 * What the agent the bridge launches is configured with, read from its own files.
 *
 * The configuration edited here is the one Pi is started with: `PI_CODING_AGENT_DIR` is pinned to
 * `~/.gentle-shell/agent` by `pi-environment.ts`, resolved through `gentleHomes()` like every other
 * family, so `<agentHome>/settings.json`, `<agentHome>/mcp.json` and `<agentHome>/skills` are the
 * agent's config — `~/.pi/agent` is Pi's own and is never read as this engine's.
 *
 * The three files belong to Pi, and so do the rules for reading them: skills discovery (which folders,
 * which `SKILL.md`, which collisions) and MCP validation are not re-implemented here. The bridge
 * imports Pi's own compiled modules and calls them, so the view cannot drift from what the agent will
 * actually load.
 *
 * Reading is all this module does: no file is created, locked, migrated or rewritten, not even a lock
 * file. A file Pi cannot read is reported as `unavailable` with a reason and a message, and its
 * projection is empty rather than a default standing in for it — an empty package list is never
 * composed to mean "malformed settings".
 *
 * MCP configuration carries credentials, and this module is the one place they are removed. A header
 * or environment value is reported by name with `<redacted>` as its value, an OAuth secret is only
 * reported as "this server signs in", a URL is reduced to scheme, host and path so a token in the
 * query string or in the userinfo never travels, and an argument that pairs a secret-looking name with
 * a value is redacted the same way. Nothing here writes to a log either, and an error message carries
 * a path and Pi's own diagnosis, never a value from the file.
 */

/**
 * The keys of `settings.json` this view reports: the persisted model the settings sheet already shows.
 *
 * Deliberately small. A key not named here is left exactly where it is and is not reported at all, so a
 * future editor has a written list of what it may touch, and a key holding something with a credential
 * in it can never be published by accident.
 */
export const SETTINGS_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;

/** The names this module calls. A Pi that lacks one is reported by name, not guessed around. */
const REQUIRED = ["loadSkills", "loadMcpConfig"] as const;

interface PiSkill {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
	readonly sourceInfo?: { readonly scope?: string };
}

interface PiDiagnostic {
	readonly type: string;
	readonly message: string;
	readonly path?: string;
}

interface PiMcpConfig {
	readonly exposure?: string;
	readonly enabled?: boolean;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly url?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly oauth?: Readonly<Record<string, unknown>>;
	readonly auth?: Readonly<Record<string, unknown>>;
}

interface PiMcpEntry {
	readonly name: string;
	readonly config: PiMcpConfig;
}

/** The part of Pi's own library this module uses. */
interface PiLibrary {
	loadSkills(options: {
		cwd: string;
		agentDir: string;
		skillPaths: string[];
		includeDefaults: boolean;
	}): { skills: readonly PiSkill[]; diagnostics: readonly PiDiagnostic[] };
	loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): {
		servers: readonly PiMcpEntry[];
		errors: readonly string[];
	};
}

export interface SettingsOptions extends GentleOptions {
	/** Load Pi's library some other way; a test points this at a stand-in. */
	readonly loadLibrary?: (root: string) => Promise<unknown>;
}

// ---- loading Pi's library ----

const loaded = new Map<string, Promise<PiLibrary>>();

/** Load Pi's skills and MCP modules from `root` and check they offer what this module calls. */
export function loadPiLibrary(root: string): Promise<PiLibrary> {
	const cached = loaded.get(root);
	if (cached !== undefined) return cached;
	const pending = readModules(root);
	// A failed load is not remembered: fixing the install must not need a bridge restart.
	pending.catch(() => loaded.delete(root));
	loaded.set(root, pending);
	return pending;
}

async function readModules(root: string): Promise<PiLibrary> {
	const files = [join(root, "core", "skills.js"), join(root, "extensions", "mcp", "config.js")];
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
	return checked(modules);
}

/** The two names this module calls, or a failure that says which is missing. */
function checked(modules: Record<string, unknown>): PiLibrary {
	try {
		return requireFunctions<PiLibrary>(modules, REQUIRED, "settings library");
	} catch (error) {
		// The shared check phrases its failure as gentle-pi's; these modules belong to Pi, so the reason
		// is kept and the sentence is the one that is true for the files being read.
		if (error instanceof GentlePiLibraryError) {
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

async function library(options: SettingsOptions): Promise<PiLibrary> {
	if (options.loadLibrary !== undefined) {
		return checked((await options.loadLibrary(piRoot())) as Record<string, unknown>);
	}
	return await loadPiLibrary(piRoot());
}

// ---- the view ----

/** The homes the bridge launches Pi with, and the three files read from the agent's own home. */
export async function settingsRead(workspace: string, options: SettingsOptions = {}): Promise<SettingsView> {
	const { configHome, agentHome } = gentleHomes(options);

	let lib: PiLibrary;
	try {
		lib = await library(options);
	} catch (error) {
		if (error instanceof GentlePiLibraryError) return allUnavailable(agentHome, configHome, error.reason, error.message);
		throw error;
	}

	const config = readConfig(agentHome);
	const skills = readSkills(lib, workspace, agentHome, config.skillPaths);
	const mcp = readMcp(lib, workspace, agentHome);
	const sections = [config.section, skills, mcp];
	const broken = sections.find((section) => section.state === "unavailable");

	return {
		state: broken === undefined ? "ok" : "unavailable",
		reason: broken?.reason ?? null,
		message: broken?.message ?? "",
		agentHome,
		configHome,
		settings: config.section,
		skills,
		mcp,
	};
}

/** Every section says the same thing, so nothing reads as an empty configuration when the library is gone. */
function allUnavailable(
	agentHome: string,
	configHome: string,
	reason: SettingsFailureReason,
	message: string,
): SettingsView {
	return {
		state: "unavailable",
		reason,
		message,
		agentHome,
		configHome,
		settings: {
			state: "unavailable",
			reason,
			message,
			path: join(agentHome, "settings.json"),
			stored: false,
			keys: [],
			packages: [],
			notes: [],
		},
		skills: {
			state: "unavailable",
			reason,
			message,
			path: join(agentHome, "skills"),
			paths: [],
			entries: [],
			notes: [],
		},
		mcp: {
			state: "unavailable",
			reason,
			message,
			path: join(agentHome, "mcp.json"),
			stored: false,
			servers: [],
			notes: [],
		},
	};
}

// ---- settings.json ----

interface ConfigRead {
	readonly section: SettingsConfigSection;
	/** Extra skill paths the file names, which is what makes a skill `temporary` for Pi. */
	readonly skillPaths: readonly string[];
}

function readConfig(agentHome: string): ConfigRead {
	const path = join(agentHome, "settings.json");
	const invalid = (message: string): ConfigRead => ({
		section: { state: "unavailable", reason: "file-invalid", message, path, stored: existsSync(path), keys: [], packages: [], notes: [] },
		skillPaths: [],
	});

	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent(agentHome);
		return invalid(`${path} could not be read (${messageOf(error)}), so nothing was assumed about it.`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(text));
	} catch (error) {
		return invalid(invalidMessage(path, messageOf(error)));
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return invalid(invalidMessage(path, "the file is not a JSON object"));
	}

	const file = parsed as Record<string, unknown>;
	const notes: string[] = [];
	const keys = keysOf(file, notes);
	const packages = packagesOf(file["packages"], notes);
	const skillPaths = skillPathsOf(file["skills"], notes);
	return { section: { state: "ok", reason: null, message: "", path, stored: true, keys, packages, notes }, skillPaths };
}

/** No file yet: every key is unset, and the view says so instead of writing one. */
function absent(agentHome: string): ConfigRead {
	const path = join(agentHome, "settings.json");
	return {
		section: {
			state: "ok",
			reason: null,
			message: "",
			path,
			stored: false,
			keys: SETTINGS_KEYS.map((key) => ({ key, value: null })),
			packages: [],
			notes: [`${path} does not exist yet, so every key is unset and no package is installed.`],
		},
		skillPaths: [],
	};
}

function invalidMessage(path: string, why: string): string {
	return `${path} is not a settings file Pi accepts, so it was left alone: ${why}. Fix or remove it, then reload.`;
}

function keysOf(file: Record<string, unknown>, notes: string[]): SettingsKeyValue[] {
	return SETTINGS_KEYS.map((key) => {
		const value = file[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return { key, value };
		if (value !== undefined && value !== null) {
			notes.push(`"${key}" in settings.json is not a value this view shows, so it is reported as unset and left alone.`);
		}
		return { key, value: null };
	});
}

function packagesOf(raw: unknown, notes: string[]): SettingsPackage[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		notes.push('"packages" in settings.json is not a list, so it is reported as empty and left alone.');
		return [];
	}
	const packages: SettingsPackage[] = [];
	for (const [index, entry] of raw.entries()) {
		const package_ = packageOf(entry);
		if (package_ === null) {
			notes.push(`packages[${index}] in settings.json is not a package source, so it is skipped and left alone.`);
			continue;
		}
		packages.push(package_);
	}
	return packages;
}

/** Pi accepts a bare source or an object that says what of the package to load. */
function packageOf(entry: unknown): SettingsPackage | null {
	if (typeof entry === "string" && entry.trim().length > 0) {
		return { source: entry, autoload: true, extensions: [], skills: [], prompts: [], themes: [] };
	}
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
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

/** The extra skill paths `settings.json` names, which are passed to Pi's own discovery unchanged. */
function skillPathsOf(raw: unknown, notes: string[]): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		notes.push('"skills" in settings.json is not a list of paths, so it is reported as empty and left alone.');
		return [];
	}
	const paths = stringsOf(raw);
	if (paths.length !== raw.length) notes.push('"skills" in settings.json names something that is not a path, so it is skipped and left alone.');
	return paths;
}

function stringsOf(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

// ---- skills ----

function readSkills(
	lib: PiLibrary,
	workspace: string,
	agentHome: string,
	skillPaths: readonly string[],
): SettingsSkillsSection {
	const path = join(agentHome, "skills");
	let result: ReturnType<PiLibrary["loadSkills"]>;
	try {
		result = lib.loadSkills({ cwd: workspace, agentDir: agentHome, skillPaths: [...skillPaths], includeDefaults: true });
	} catch (error) {
		return {
			state: "unavailable",
			reason: "file-invalid",
			message: `the skills on disk could not be read (${messageOf(error)}), so none is listed.`,
			path,
			paths: [...skillPaths],
			entries: [],
			notes: [],
		};
	}

	const entries: SettingsSkill[] = result.skills
		.map((skill) => ({
			name: skill.name,
			scope: scopeOf(skill),
			path: skill.filePath,
			description: skill.description,
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
	const notes = result.diagnostics.map((diagnostic) =>
		diagnostic.path === undefined ? diagnostic.message : `${diagnostic.path}: ${diagnostic.message}`,
	);
	if (entries.length === 0 && notes.length === 0) notes.push(`no skill was found in ${path}, project skills or the paths settings.json names.`);
	return { state: "ok", reason: null, message: "", path, paths: [...skillPaths], entries, notes };
}

/** Pi's own scope for a skill. A path `settings.json` names is `temporary`, not one of its two folders. */
function scopeOf(skill: PiSkill): SettingsSkill["scope"] {
	const scope = skill.sourceInfo?.scope;
	return scope === "user" || scope === "project" ? scope : "temporary";
}

// ---- mcp.json ----

function readMcp(lib: PiLibrary, workspace: string, agentHome: string): SettingsMcpSection {
	const path = join(agentHome, "mcp.json");
	const stored = existsSync(path);
	let result: ReturnType<PiLibrary["loadMcpConfig"]>;
	try {
		// The project file is a repository's business and overrides the global one for one folder, so
		// this view — the agent's own configuration — reads the global file only.
		result = lib.loadMcpConfig({ agentDir: agentHome, cwd: workspace, projectTrusted: false });
	} catch (error) {
		return {
			state: "unavailable",
			reason: "file-invalid",
			message: `${path} could not be read (${messageOf(error)}), so no server is listed.`,
			path,
			stored,
			servers: [],
			notes: [],
		};
	}

	const notes = [...result.errors];
	const servers = [...result.servers].map(serverOf).sort((left, right) => left.name.localeCompare(right.name));
	if (servers.length === 0 && notes.length > 0) {
		return {
			state: "unavailable",
			reason: "file-invalid",
			message: `${path} is not an mcp.json Pi accepts, so it was left alone: ${notes.join("; ")}. Fix or remove it, then reload.`,
			path,
			stored,
			servers: [],
			notes: [],
		};
	}
	if (!stored) notes.push(`${path} does not exist yet, so no MCP server is configured.`);
	return { state: "ok", reason: null, message: "", path, stored, servers, notes };
}

/** A server as the panel may see it: every value that can hold a credential is left out. */
function serverOf(entry: PiMcpEntry): SettingsMcpServer {
	const config = entry.config;
	const stdio = config.command !== undefined;
	return {
		name: entry.name,
		transport: stdio ? "stdio" : "http",
		enabled: config.enabled !== false,
		exposure: config.exposure ?? "codemode",
		command: stdio ? (config.command ?? null) : null,
		args: stdio ? (config.args ?? []).map(redactedArgument) : [],
		url: config.url === undefined ? null : redactedUrl(config.url),
		headers: secretNames(config.headers),
		environment: secretNames(config.env),
		oauth: config.oauth !== undefined || config.auth !== undefined,
	};
}

// ---- small helpers ----

/** A settings file written by a Windows editor may start with a byte-order mark Pi strips. */
function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
