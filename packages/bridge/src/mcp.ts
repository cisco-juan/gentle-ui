import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	ConfigFailureReason,
	ConfigPlanView,
	McpChange,
	McpOperation,
	McpView,
	SettingsMcpServer,
	SettingsSecretName,
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
 * The agent's `mcp.json`, written with Pi's own MCP code.
 *
 * `<agentHome>/mcp.json` belongs to Pi, and so do the rules for what a server is: which fields a transport
 * takes, which names are allowed, how an exposure is spelled. This module imports Pi's own compiled MCP
 * modules — `loadMcpConfig`, `validateMcpServerConfig` and the three `…McpServerConfig` writers — by
 * absolute path, the way `settings.ts` already does, because the package's `exports` map blocks a deep
 * import. Nothing about the format is re-implemented here.
 *
 * Pi's writers take a path and write it directly. They are therefore pointed at a copy in a scratch
 * folder, the result is parsed back, and `config-write.ts` — the same foundation the packages family
 * uses — performs the one write that reaches the real file: behind a confirmed digest, with a backup of
 * the bytes it replaces, atomically and `0600`. Two families writing the same kind of file with
 * separate backup logic would each keep a backup of the other's writes, so there is one mechanism.
 *
 * This is the family that handles credentials, and it is the one place they are removed:
 *
 * - `update` is a **patch**. A field the request does not mention is not read out, not sent and not sent
 *   back: it is kept exactly as the file has it. Editing a command therefore never round-trips a header
 *   value through the panel, which is the only way a secret can keep being a secret.
 * - Every server the panel sees is a projection: a header or environment name with `<redacted>` for its
 *   value, a URL reduced to scheme, host and path, and `oauth: true` for "this server signs in".
 * - The plan's summary names fields, never values, and the file's own text is not part of any answer.
 * - A message this module builds from an error drops the text V8 quotes when a file is not JSON, because
 *   that text is the beginning of the file — and the file is where the tokens are.
 *
 * A file Pi cannot read is `unavailable` with the reason, and it is never replaced (C2).
 */

/** The names this module calls. A Pi that lacks one is reported by name, not guessed around. */
const REQUIRED = ["loadMcpConfig", "validateMcpServerConfig", "addMcpServerConfig", "updateMcpServerConfig", "removeMcpServerConfig"] as const;

/** The family name: the message kind, and the folder this family's backups live in. */
const FAMILY = "mcp";

export interface McpOptions extends GentleOptions {
	/** Load Pi's library some other way; a test points this at a stand-in. */
	readonly loadLibrary?: (root: string) => Promise<unknown>;
}

/** What `preview` and `apply` are asked for, straight off the wire and therefore unchecked. */
export interface McpRequestInput {
	readonly operation: unknown;
	readonly name: unknown;
	/** The fields to set. Absent for `remove`; a field that is absent is kept as it is on disk. */
	readonly server?: unknown;
}

// ---- Pi's own modules ----

/** What Pi's compiled MCP modules offer, as far as this module calls them. */
export interface McpLibrary {
	loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): {
		servers: readonly { readonly name: string; readonly config: Record<string, unknown> }[];
		errors: readonly string[];
	};
	/** Pi's own rule for one entry: the config, or a sentence saying what is wrong with it. */
	validateMcpServerConfig(name: string, raw: unknown): Record<string, unknown> | string;
	addMcpServerConfig(path: string, name: string, config: unknown): boolean;
	updateMcpServerConfig(
		path: string,
		name: string,
		patch: { readonly enabled?: boolean; readonly exposure?: string },
		options?: { readonly override?: boolean },
	): void;
	removeMcpServerConfig(path: string, name: string): boolean;
}

const loaded = new Map<string, Promise<McpLibrary>>();

/**
 * Load Pi's MCP modules from `root`.
 *
 * `loadMcpConfig` and the three writers live in `extensions/mcp/config.js`, but that file re-exports
 * only `getMcpToolExposure` from core: `validateMcpServerConfig` is `core/mcp-servers.js`. Both are
 * imported by absolute path and merged, because the `exports` map blocks a deep import.
 */
export function loadMcpLibrary(root: string): Promise<McpLibrary> {
	const cached = loaded.get(root);
	if (cached !== undefined) return cached;
	const pending = readModules(root);
	// A failed load is not remembered: fixing the install must not need a bridge restart.
	pending.catch(() => loaded.delete(root));
	loaded.set(root, pending);
	return pending;
}

async function readModules(root: string): Promise<McpLibrary> {
	const files = [join(root, "extensions", "mcp", "config.js"), join(root, "core", "mcp-servers.js")];
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
		return requireFunctions<McpLibrary>(modules, REQUIRED, "MCP library");
	} catch (error) {
		if (error instanceof GentlePiLibraryError) {
			// The shared check phrases its failure as gentle-pi's; these modules belong to Pi.
			throw new GentlePiLibraryError(
				error.reason,
				error.message.replace("gentle-pi's MCP library", "the installed Pi's MCP library"),
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

async function library(options: McpOptions): Promise<McpLibrary> {
	if (options.loadLibrary !== undefined) {
		return requireFunctions<McpLibrary>((await options.loadLibrary(piRoot())) as Record<string, unknown>, REQUIRED, "MCP library");
	}
	return await loadMcpLibrary(piRoot());
}

// ---- reading ----

/** Every server Pi loads from the agent's `mcp.json`, projected for the panel. Reading never writes. */
export async function mcpList(workspace: string, options: McpOptions = {}): Promise<McpView> {
	const { agentHome } = gentleHomes(options);
	const path = join(agentHome, "mcp.json");
	const stored = existsSync(path);

	let lib: McpLibrary;
	try {
		lib = await library(options);
	} catch (error) {
		if (error instanceof GentlePiLibraryError) return unavailable(path, stored, error.reason, error.message);
		throw error;
	}

	let result: ReturnType<McpLibrary["loadMcpConfig"]>;
	try {
		// The project file is a repository's business and overrides the global one for one folder, so this
		// family — the agent's own configuration — reads and writes the global file only.
		result = lib.loadMcpConfig({ agentDir: agentHome, cwd: workspace, projectTrusted: false });
	} catch (error) {
		return unavailable(path, stored, "file-invalid", `${path} could not be read (${withoutFileText(messageOf(error))}), so no server is listed.`);
	}

	const notes = result.errors.map(withoutFileText);
	const servers = projectServers(Object.fromEntries(result.servers.map((entry) => [entry.name, entry.config])));
	if (servers.length === 0 && notes.length > 0) {
		return unavailable(path, stored, "file-invalid", invalidMessage(path, notes));
	}
	if (!stored) notes.push(`${path} does not exist yet, so no MCP server is configured.`);
	return { state: "ok", reason: null, message: "", path, stored, servers, notes, plan: null, change: null, backup: null };
}

// ---- preview ----

/**
 * The plan an `add`, `update` or `remove` would perform, with the digest the confirmation carries.
 *
 * Nothing is written: the edit is made by Pi's own writer on a copy in a scratch folder, so the text the
 * plan describes is the text Pi would write, without a byte reaching the agent's home.
 */
export async function mcpPreview(workspace: string, input: McpRequestInput, options: McpOptions = {}): Promise<McpView> {
	const { agentHome } = gentleHomes(options);
	const path = join(agentHome, "mcp.json");

	let lib: McpLibrary;
	try {
		lib = await library(options);
	} catch (error) {
		if (error instanceof GentlePiLibraryError) return unavailable(path, existsSync(path), error.reason, error.message);
		throw error;
	}

	const request = requestOf(lib, input);
	try {
		const preview = await configPreview(writeRequest(lib, request, path));
		return viewOf(preview, path, null, request.name);
	} catch (error) {
		if (error instanceof ConfigWriteError) return refusedOrUnavailable(error, path);
		throw error;
	}
}

// ---- apply ----

/** Perform exactly the plan the confirmation showed, or say why it was refused. */
export async function mcpApply(
	workspace: string,
	input: McpRequestInput,
	digest: unknown,
	options: McpOptions = {},
): Promise<McpView> {
	const { agentHome, configHome } = gentleHomes(options);
	const path = join(agentHome, "mcp.json");

	let lib: McpLibrary;
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
		const applied = await configApply(writeRequest(lib, request, path), digest, { configHome });
		return viewOf(applied, path, applied, request.name);
	} catch (error) {
		if (error instanceof ConfigWriteError) return refusedOrUnavailable(error, path);
		throw error;
	}
}

// ---- the change, made with Pi's own writer over a scratch copy ----

function writeRequest(lib: McpLibrary, request: McpRequest, path: string): ConfigWriteRequest {
	return {
		operation: `${FAMILY}.${request.operation}`,
		family: FAMILY,
		path,
		// Pi takes no lock on `mcp.json` — its own `/mcp` command reads and rewrites the file the same way
		// — so this family does not invent one; the plan's before/after comparison is what keeps a
		// concurrent change from being clobbered.
		change: async (current) => changeOf(lib, request, path, current),
	};
}

/**
 * The new content of `mcp.json`, edited by Pi and then described to the confirmation.
 *
 * The three checks that are this family's own: a name may not already exist for an `add` (nor be missing
 * for an `update` or `remove`), the fields a request sets must be the ones its transport takes, and a
 * patch that would leave the file exactly as it is is refused instead of being applied for nothing.
 */
async function changeOf(lib: McpLibrary, request: McpRequest, path: string, current: ConfigFileState): Promise<ConfigChange> {
	const servers = serversOfFile(current, path);
	const existing = servers[request.name];
	if (request.operation === "add" && existing !== undefined) {
		throw new Error(`${path} already defines MCP server "${request.name}", so nothing was written; update it instead.`);
	}
	if (request.operation !== "add" && existing === undefined) {
		throw new Error(`${path} does not define MCP server "${request.name}", so there is nothing to ${request.operation}.`);
	}

	const entry =
		request.operation === "remove"
			? null
			: request.operation === "add"
				? addEntry(lib, request)
				: updateEntry(lib, request, requireRecord(path, request.name, existing));

	const next = rewriteOnScratch(lib, request, path, current, entry);
	if (current.value !== null && canonical(next) === canonical(current.value)) {
		throw new Error(`${path} would hold exactly what it holds now, so nothing was written.`);
	}

	return { next, summary: summaryOf(request, entry, countOf(current.value), countOf(next)) };
}

/**
 * The file as Pi's writer would leave it, without writing the real one.
 *
 * Pi's writers take a path, so the file is copied into a scratch folder and edited there; the result is
 * parsed back and handed to `config-write`, which owns the backup and the atomic `0600` write. The copy
 * is deleted whatever happens, and it lives outside the worktree and outside the person's homes.
 */
function rewriteOnScratch(
	lib: McpLibrary,
	request: McpRequest,
	path: string,
	current: ConfigFileState,
	entry: JsonRecord | null,
): JsonObject {
	const scratch = mkdtempSync(join(tmpdir(), "gentle-mcp-"));
	try {
		const file = join(scratch, "mcp.json");
		if (current.text !== null) writeFileSync(file, current.text);
		if (request.operation === "remove") {
			if (!lib.removeMcpServerConfig(file, request.name)) {
				throw new Error(`${path} does not define MCP server "${request.name}", so there is nothing to remove.`);
			}
		} else if (request.operation === "update" && defaultsOnly(request.patch)) {
			// Only the two fields Pi's own patch understands: its writer is used, so the defaults it elides
			// stay elided exactly as `/mcp` would leave them.
			lib.updateMcpServerConfig(file, request.name, defaultsOf(request.patch, entry ?? {}));
		} else {
			// `add` creates or replaces one entry and keeps the rest of the file; an `update` of anything
			// else is the entry this family merged, which is why the fields it did not mention survive.
			lib.addMcpServerConfig(file, request.name, entry);
		}
		return parseObject(path, readFileSync(file, "utf8"));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** The entry an `add` writes, validated by Pi before anything is written. */
function addEntry(lib: McpLibrary, request: McpRequest): JsonRecord {
	const transport = request.patch.values["transport"];
	if (transport === undefined) throw new Error('an add names the transport: "stdio" or "http".');
	requireApplicable(request.patch, transport as Transport);
	return validated(lib, request.name, without(request.patch, new Set(["transport"])));
}

/**
 * The entry an `update` writes: what the file already holds, with the fields the request names on top.
 *
 * Nothing is read out of the file and sent anywhere — the merge happens here, on this side of the wire,
 * which is what lets a header keep a value the panel never sees.
 */
function updateEntry(lib: McpLibrary, request: McpRequest, base: JsonRecord): JsonRecord {
	const requested = request.patch.values["transport"] as Transport | undefined;
	const transport = requested ?? transportOf(base);
	// An entry that says neither is not a server at all; Pi's own validation says so below.
	if (transport !== null) requireApplicable(request.patch, transport);
	const leaving = requested !== undefined && requested !== transportOf(base);

	const merged: JsonRecord = { ...base };
	if (leaving) {
		// What the old transport meant does not survive the move, and Pi infers the transport from the
		// fields that remain — so `type` goes with them.
		for (const key of requested === "http" ? STDIO_FIELDS : HTTP_FIELDS) delete merged[key];
		for (const key of requested === "http" ? ["type"] : ["type", "oauth", "auth"]) delete merged[key];
	}
	for (const key of request.patch.keys) {
		if (key !== "transport") merged[key] = request.patch.values[key];
	}
	return validated(lib, request.name, merged);
}

/** Pi's own validation, so an entry this cannot write is refused with Pi's own reason. */
function validated(lib: McpLibrary, name: string, draft: JsonRecord): JsonRecord {
	const result = lib.validateMcpServerConfig(name, draft);
	if (typeof result === "string") throw new Error(result);
	return result;
}

// ---- the request, off the wire ----

/** The MCP operations this family writes, and nothing else. */
const OPERATIONS: readonly McpOperation[] = ["add", "update", "remove"];

type Transport = "stdio" | "http";

/** The fields each transport takes; `enabled`, `exposure` and `description` belong to both. */
const STDIO_FIELDS: readonly string[] = ["command", "args", "cwd", "env"];
const HTTP_FIELDS: readonly string[] = ["url", "headers"];

/** Every field a request may set. `oauth`, `auth` and `toolExposure` are deliberately absent: they nest. */
const PATCH_FIELDS: readonly string[] = ["transport", ...STDIO_FIELDS, ...HTTP_FIELDS, "enabled", "exposure", "description", "timeout"];

/** The fields a request names, in the order the request named them. */
interface Patch {
	readonly keys: readonly string[];
	readonly values: Readonly<JsonRecord>;
}

interface McpRequest {
	readonly operation: McpOperation;
	readonly name: string;
	readonly patch: Patch;
}

function requestOf(lib: McpLibrary, input: McpRequestInput): McpRequest {
	const operation = operationOf(input.operation);
	const name = requireName(lib, input.name);
	const patch = patchOf(input.server);
	if (operation === "add" && patch.values["transport"] === undefined) {
		throw new Error('an add names the transport: "stdio" or "http".');
	}
	if (operation === "update" && patch.keys.length === 0) {
		throw new Error("an update names no field, so nothing would be written.");
	}
	if (operation === "remove" && patch.keys.length > 0) {
		throw new Error("a remove takes the whole server out, so it names no field.");
	}
	return { operation, name, patch };
}

/** `operation` arrives as unchecked JSON, so it is compared exactly: no trimming, no case folding. */
function operationOf(operation: unknown): McpOperation {
	if (typeof operation === "string" && (OPERATIONS as readonly string[]).includes(operation)) return operation as McpOperation;
	throw new Error(
		`${JSON.stringify(operation) ?? String(operation)} is not an MCP operation this can write; use add, update or remove.`,
	);
}

/** Pi's own rule for a server name, asked once so every operation refuses the same names. */
function requireName(lib: McpLibrary, name: unknown): string {
	if (typeof name !== "string" || name.trim().length === 0) throw new Error("an MCP server name must be a non-empty string");
	// `validateMcpServerConfig` checks the name before anything else, so any complaint here is about it.
	const probe = lib.validateMcpServerConfig(name, { command: "probe" });
	if (typeof probe === "string") throw new Error(probe);
	return name;
}

function patchOf(server: unknown): Patch {
	if (server === undefined) return { keys: [], values: {} };
	if (!isRecord(server)) throw new Error("the fields to change must be an object");
	const unknownField = Object.keys(server).find((key) => !PATCH_FIELDS.includes(key));
	if (unknownField !== undefined) {
		throw new Error(`${JSON.stringify(unknownField)} is not a field this can write; a server sets ${PATCH_FIELDS.join(", ")}.`);
	}
	const transport = server["transport"];
	if (transport !== undefined && transport !== "stdio" && transport !== "http") {
		throw new Error(`${JSON.stringify(transport)} is not a transport this can write; use stdio or http.`);
	}
	return { keys: Object.keys(server), values: server };
}

/** A field the selected transport does not take is a mistake, not something to write and let Pi ignore. */
function requireApplicable(patch: Patch, transport: Transport): void {
	const foreign = transport === "stdio" ? HTTP_FIELDS : STDIO_FIELDS;
	const named = patch.keys.find((key) => foreign.includes(key));
	if (named !== undefined) {
		throw new Error(`a server on the ${transport} transport does not take "${named}", so nothing was written.`);
	}
}

// ---- the file ----

/** The `mcpServers` object as it is, or a `file-invalid` refusal when it is not one. */
function serversOfFile(current: ConfigFileState, path: string): Record<string, unknown> {
	const value = current.value;
	if (value === null) return {};
	const servers = value["mcpServers"];
	if (servers === undefined) return {};
	if (!isRecord(servers)) throw new ConfigWriteError("file-invalid", invalidMessage(path, ['"mcpServers" is not an object']));
	return servers;
}

/** An entry the request is about, or a refusal saying the file cannot be edited at all. */
function requireRecord(path: string, name: string, entry: unknown): JsonRecord {
	if (!isRecord(entry)) {
		throw new ConfigWriteError("file-invalid", invalidMessage(path, [`server "${name}" is not an object`]));
	}
	return entry;
}

function parseObject(path: string, text: string): JsonObject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
	} catch (error) {
		throw new ConfigWriteError("file-invalid", invalidMessage(path, [withoutFileText(messageOf(error))]));
	}
	if (!isRecord(parsed)) throw new ConfigWriteError("file-invalid", invalidMessage(path, ["the file is not a JSON object"]));
	return parsed as JsonObject;
}

function invalidMessage(path: string, why: readonly string[]): string {
	return `${path} is not an mcp.json this can edit, so it was left alone: ${why.join("; ")}. Fix or remove it, then preview again.`;
}

// ---- the view ----

function viewOf(preview: ConfigPreviewResult, path: string, applied: { readonly backup: string | null } | null, name: string): McpView {
	const backup = applied?.backup ?? null;
	return {
		state: "ok",
		reason: null,
		message: "",
		path,
		stored: existsSync(path),
		// After an apply the file holds the plan's content; before one it still holds its own.
		servers: applied === null ? serversOfText(preview.plan.before) : projectServers(entriesOf(preview.next)),
		notes: backup === null ? [] : [`the previous ${path} was kept at ${backup}.`],
		plan: planViewOf(preview),
		change: changeOfView(preview, name),
		backup,
	};
}

/** What the plan changes, as the two projections of one entry: as it was, and as it would be. */
function changeOfView(preview: ConfigPreviewResult, name: string): McpChange {
	const before = projectEntry(name, entryIn(textAsObject(preview.plan.before), name));
	const after = projectEntry(name, entryIn(preview.next, name));
	return { before, after };
}

function planViewOf(preview: ConfigPreviewResult): ConfigPlanView {
	return {
		operation: preview.plan.operation,
		target: preview.plan.target,
		digest: preview.digest,
		summary: preview.summary,
	};
}

function refusedOrUnavailable(error: ConfigWriteError, path: string): McpView {
	const refused = error.reason === "stale-plan" || error.reason === "changed-on-disk";
	return {
		state: refused ? "refused" : "unavailable",
		reason: error.reason,
		message: withoutFileText(error.message),
		path,
		stored: existsSync(path),
		servers: refused ? serversOfText(readTextOrNull(path)) : [],
		notes: [],
		plan: null,
		change: null,
		backup: null,
	};
}

function unavailable(path: string, stored: boolean, reason: ConfigFailureReason, message: string): McpView {
	return { state: "unavailable", reason, message: withoutFileText(message), path, stored, servers: [], notes: [], plan: null, change: null, backup: null };
}

function summaryOf(request: McpRequest, entry: JsonRecord | null, before: number, after: number): string[] {
	const first =
		request.operation === "add"
			? `mcp: add server "${request.name}" (${transportOf(entry ?? {}) ?? "stdio"})`
			: request.operation === "update"
				? `mcp: update server "${request.name}": ${request.patch.keys.join(", ")}`
				: `mcp: remove server "${request.name}"`;
	return [first, `mcp: servers ${before} → ${after}`];
}

function countOf(value: JsonObject | null): number {
	if (value === null) return 0;
	return Object.keys(entriesOf(value)).length;
}

/** The `mcpServers` object of a parsed file, without insisting that it is one. */
function entriesOf(value: JsonObject): Record<string, unknown> {
	const servers = value["mcpServers"];
	return isRecord(servers) ? servers : {};
}

function entryIn(value: JsonObject | null, name: string): unknown {
	return value === null ? undefined : entriesOf(value)[name];
}

function serversOfText(text: string | null): SettingsMcpServer[] {
	return projectServers(entriesOf(textAsObject(text) ?? {}));
}

function textAsObject(text: string | null): JsonObject | null {
	if (text === null) return null;
	try {
		const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
		return isRecord(parsed) ? (parsed as JsonObject) : null;
	} catch {
		return null;
	}
}

function readTextOrNull(path: string): string | null {
	try {
		return readConfigFile(path).text;
	} catch {
		return null;
	}
}

function projectServers(servers: Record<string, unknown>): SettingsMcpServer[] {
	return Object.entries(servers)
		.map(([name, config]) => projectEntry(name, config))
		.filter((entry): entry is SettingsMcpServer => entry !== null)
		.sort((left, right) => left.name.localeCompare(right.name));
}

function projectEntry(name: string, config: unknown): SettingsMcpServer | null {
	return isRecord(config) ? serverOf(name, config) : null;
}

/**
 * A server as the panel may see it: every value that can hold a credential is left out.
 *
 * The same projection `settings.ts` publishes for the read-only view, kept here because that module does
 * not export it and because a write's answer has to look exactly like a read's. When one changes, both
 * change.
 */
function serverOf(name: string, config: JsonRecord): SettingsMcpServer {
	const command = config["command"];
	const stdio = typeof command === "string";
	const exposure = config["exposure"];
	return {
		name,
		transport: stdio ? "stdio" : "http",
		enabled: config["enabled"] !== false,
		exposure: typeof exposure === "string" ? exposure : "codemode",
		command: stdio ? command : null,
		args: stdio && Array.isArray(config["args"]) ? config["args"].filter(isString).map(redactedArgument) : [],
		url: typeof config["url"] === "string" ? redactedUrl(config["url"]) : null,
		headers: secretNames(config["headers"]),
		environment: secretNames(config["env"]),
		oauth: config["oauth"] !== undefined || config["auth"] !== undefined,
	};
}

/** A name with no value: the panel may show that a header or a variable exists, never what it holds. */
function secretNames(raw: unknown): SettingsSecretName[] {
	if (!isRecord(raw)) return [];
	return Object.keys(raw)
		.sort((left, right) => left.localeCompare(right))
		.map((name) => ({ name, value: "<redacted>" as const }));
}

/**
 * Scheme, host and path only.
 *
 * A URL is the one field where a credential needs no name to live: `?token=…` and `user:pass@host` both
 * work, so both are cut out along with the fragment. An unparsable URL is not repeated either — it
 * could hold anything.
 */
function redactedUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "<redacted>";
	}
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	return url.toString();
}

/** `--name=value` is redacted when the name reads like a credential; a bare token cannot be told apart. */
const SECRET_ARGUMENT_NAME = /(key|token|secret|password|passwd|credential|auth)/i;
const PAIRED_ARGUMENT = /^(-{0,2}[A-Za-z0-9_-]+)=(.+)$/;

function redactedArgument(argument: string): string {
	const name = PAIRED_ARGUMENT.exec(argument)?.[1];
	if (name === undefined || !SECRET_ARGUMENT_NAME.test(name)) return argument;
	return `${name}=<redacted>`;
}

// ---- small helpers ----

/**
 * Drop the file's own text from a message.
 *
 * A JSON parse error quotes the characters it choked on — `Unexpected token 'A', "Authorizat"...` — and
 * those characters are the beginning of a file that holds tokens. Everything the quote opens is dropped;
 * a diagnosis that is only a position (`at position 50`) is kept, so the reason stays useful.
 */
function withoutFileText(message: string): string {
	if (!message.includes(" is not valid JSON")) return message;
	const quote = message.indexOf(', "');
	return quote === -1 ? message : `${message.slice(0, quote)}, the file is not valid JSON`;
}

/** The transport a stored entry speaks, or null when it says neither. */
function transportOf(config: JsonRecord): Transport | null {
	if (typeof config["url"] === "string") return "http";
	if (typeof config["command"] === "string") return "stdio";
	return null;
}

/** `enabled` and `exposure` are the two fields Pi's own `updateMcpServerConfig` patches. */
function defaultsOnly(patch: Patch): boolean {
	return patch.keys.every((key) => key === "enabled" || key === "exposure");
}

function defaultsOf(patch: Patch, entry: JsonRecord): { readonly enabled?: boolean; readonly exposure?: string } {
	const out: { enabled?: boolean; exposure?: string } = {};
	if (patch.keys.includes("enabled") && typeof entry["enabled"] === "boolean") out.enabled = entry["enabled"];
	if (patch.keys.includes("exposure") && typeof entry["exposure"] === "string") out.exposure = entry["exposure"];
	return out;
}

function without(patch: Patch, skip: ReadonlySet<string>): JsonRecord {
	const out: JsonRecord = {};
	for (const key of patch.keys) {
		if (!skip.has(key)) out[key] = patch.values[key];
	}
	return out;
}

/** JSON with object keys sorted: the same value always reads the same, whatever order it was written in. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(",")}}`;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type JsonRecord = Record<string, unknown>;
