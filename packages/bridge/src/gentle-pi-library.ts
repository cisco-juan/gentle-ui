import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiEnvironment } from "./pi-environment.ts";

/**
 * Loading gentle-pi's own TypeScript library into the bridge.
 *
 * The files gentle-pi owns (profiles, the permission-mode default) carry their own rules for what is
 * valid and how it is written atomically. Re-implementing them here would fork the format the day
 * gentle-pi changes it, so the bridge loads the library from the installed package and calls it. Node will
 * not strip types from files under `node_modules`, so the modules are loaded with `jiti`, which Pi ships
 * for exactly this job.
 */

export type LibraryFailure = "library-missing" | "library-incompatible";

/** A failure the panels can name, so an unavailable answer always carries a reason and a message. */
export class GentlePiLibraryError extends Error {
	readonly reason: LibraryFailure;

	constructor(reason: LibraryFailure, message: string) {
		super(message);
		this.name = "GentlePiLibraryError";
		this.reason = reason;
	}
}

export interface GentleOptions {
	/** gentle-pi package root. When given it is the only one tried; otherwise discovery decides. */
	readonly extension?: string;
	readonly home?: string;
	/** Folder holding gentle-pi's files. Defaults to the one the bridge pins for Pi. */
	readonly configHome?: string;
	/** Pi's agent home, whose `settings.json` carries the orchestrator. Defaults to the pinned one. */
	readonly agentHome?: string;
}

/** The two folders gentle-pi and Pi keep their files in, as the bridge pins them for the agent it starts. */
export function gentleHomes(options: GentleOptions): { configHome: string; agentHome: string } {
	const home = options.home ?? homedir();
	const env = resolvePiEnvironment({ home }).env;
	return {
		configHome: options.configHome ?? env["GENTLE_SHELL_CONFIG_HOME"] ?? join(home, ".gentle-shell", "gentle-ai"),
		agentHome: options.agentHome ?? env["PI_CODING_AGENT_DIR"] ?? join(home, ".gentle-shell", "agent"),
	};
}

/** The installed gentle-pi, or a `library-missing` failure saying so. */
export function resolveExtensionRoot(options: GentleOptions): string {
	const root = options.extension ?? resolvePiEnvironment(options.home === undefined ? {} : { home: options.home }).extensionPath;
	if (root === null || root === undefined || !existsSync(join(root, "package.json"))) {
		throw new GentlePiLibraryError("library-missing", "gentle-pi is not installed, so what it keeps cannot be read.");
	}
	return root;
}

/** Load `lib/<name>.ts` for each name and merge their exports into one object. */
export async function importModules(root: string, names: readonly string[]): Promise<Record<string, unknown>> {
	for (const name of names) {
		if (!existsSync(join(root, "lib", `${name}.ts`))) {
			throw new GentlePiLibraryError("library-missing", `gentle-pi's library was not found: ${join(root, "lib", `${name}.ts`)}.`);
		}
	}

	let jitiPath: string;
	try {
		jitiPath = createRequire(join(piDirectory(root), "package.json")).resolve("jiti");
	} catch (error) {
		throw new GentlePiLibraryError(
			"library-missing",
			`jiti, which loads gentle-pi's TypeScript, could not be found next to Pi (${messageOf(error)}).`,
		);
	}

	try {
		const { createJiti } = (await import(pathToFileURL(jitiPath).href)) as {
			createJiti(base: string, options: Record<string, unknown>): { import(path: string): Promise<unknown> };
		};
		const jiti = createJiti(pathToFileURL(join(root, "package.json")).href, { moduleCache: false });
		const modules = await Promise.all(names.map((name) => jiti.import(join(root, "lib", `${name}.ts`))));
		return Object.assign({}, ...modules) as Record<string, unknown>;
	} catch (error) {
		throw new GentlePiLibraryError("library-incompatible", `gentle-pi's library could not be loaded (${messageOf(error)}).`);
	}
}

/** Check that every name this module calls is there, so a changed gentle-pi is reported by name, not guessed around. */
export function requireFunctions<T>(candidate: unknown, names: readonly string[], what: string): T {
	const record = (typeof candidate === "object" && candidate !== null ? candidate : {}) as Record<string, unknown>;
	const missing = names.filter((name) => typeof record[name] !== "function");
	if (missing.length > 0) {
		throw new GentlePiLibraryError("library-incompatible", `gentle-pi's ${what} does not offer: ${missing.join(", ")}.`);
	}
	return record as unknown as T;
}

/** Pi sits next to gentle-pi in the same `node_modules`, or inside it for a flat install. */
function piDirectory(root: string): string {
	const candidates = [
		join(root, "node_modules", "@earendil-works", "pi-coding-agent"),
		join(dirname(root), "@earendil-works", "pi-coding-agent"),
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (found === undefined) throw new Error("the Pi package is not installed beside gentle-pi");
	return realpathSync(found);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
