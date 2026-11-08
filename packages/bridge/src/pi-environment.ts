import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * How to start `pi` so it behaves like the Gentle Shell TUI does.
 *
 * The launcher never relies on the user's settings: it injects the Gentle Shell package with `-e` and
 * pins the environment, so the child uses the same agent home, config home and package tree. A bare
 * `pi --mode rpc` loads only what the settings file declares — which on this machine is everything
 * except Gentle Shell, and that is why `/gentle:*` commands were missing.
 *
 * Two details make the difference between working and `pi` exiting with code 1:
 * - the path passed to `-e` must be the **resolved** package directory, not the pnpm symlink, or the
 *   extension's own imports (`@heyhuynhgiabuu/pi-pretty`, `@earendil-works/pi-tui`) are resolved from
 *   the logical path and fail;
 * - a candidate must be able to resolve its declared dependencies, because the npm-installed copy on
 *   this machine declares extensions but has no dependency tree next to it.
 */
export interface PiEnvironment {
	/** Extra CLI arguments: `-e <package root>` when a usable package was found. */
	readonly args: readonly string[];
	/** Variables that must win over the ambient environment. */
	readonly env: Readonly<Record<string, string>>;
	/** Resolved package root passed to `-e`, or null when the agent runs bare. */
	readonly extensionPath: string | null;
}

export interface PiEnvironmentOptions {
	readonly home?: string;
	/** Explicit package root; wins over discovery. */
	readonly extension?: string;
	/** Candidate package roots, in preference order. */
	readonly candidates?: readonly string[];
	readonly exists?: (path: string) => boolean;
	readonly readFile?: (path: string) => string;
	/** Resolve one dependency from a package root; returns null when it cannot be found. */
	readonly resolveDependency?: (root: string, specifier: string) => string | null;
}

export function defaultExtensionCandidates(home = homedir()): readonly string[] {
	return [
		join(home, ".gentle-shell", "current", "node_modules", "gentle-pi"),
		join(home, ".gentle-shell", "agent", "npm", "node_modules", "gentle-pi"),
		join(home, ".pi", "agent", "npm", "node_modules", "gentle-pi"),
	];
}

export function resolvePiEnvironment(options: PiEnvironmentOptions = {}): PiEnvironment {
	const home = options.home ?? homedir();
	const exists = options.exists ?? existsSync;
	const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const resolveDependency = options.resolveDependency ?? nodeResolveDependency;

	const explicit = options.extension ?? process.env.GENTLE_PI_PACKAGE;
	const roots = options.candidates ?? defaultExtensionCandidates(home);
	const extensionPath =
		usable(explicit, exists, readFile, resolveDependency) ??
		roots.map((root) => usable(root, exists, readFile, resolveDependency)).find((root) => root !== null) ??
		null;

	const agentHome = join(home, ".gentle-shell", "agent");
	const env: Record<string, string> = {
		PI_CODING_AGENT_DIR: agentHome,
		GENTLE_PI_AGENT_HOME: agentHome,
		GENTLE_SHELL_USER_PI_HOME: join(home, ".pi", "agent"),
		GENTLE_SHELL_CONFIG_HOME: join(home, ".gentle-shell", "gentle-ai"),
		PI_PROGRAM_STATUS_APP: "gentle-shell",
		// Routes the package's dialogs and subagent activity over RPC instead of the TUI.
		GENTLE_SHELL_INTERACTIVE_HOST: "1",
	};

	return { args: extensionPath === null ? [] : ["-e", extensionPath], env, extensionPath };
}

/** Default resolver: Node's own algorithm, which follows the package's dependency links. */
function nodeResolveDependency(root: string, specifier: string): string | null {
	try {
		return createRequire(join(root, "package.json")).resolve(specifier);
	} catch {
		return null;
	}
}

/** A root is usable when it is the Gentle Shell package and every declared dependency resolves. */
function usable(
	root: string | undefined,
	exists: (path: string) => boolean,
	readFile: (path: string) => string,
	resolveDependency: (root: string, specifier: string) => string | null,
): string | null {
	if (root === undefined || root.trim().length === 0) return null;

	const manifestPath = join(root, "package.json");
	if (!exists(manifestPath)) return null;

	let manifest: { name?: string; pi?: { extensions?: unknown }; dependencies?: Record<string, string> };
	try {
		manifest = JSON.parse(readFile(manifestPath)) as typeof manifest;
	} catch {
		return null;
	}
	if (manifest.name !== "gentle-pi") return null;
	if (!Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length === 0) return null;

	const resolved = realpath(root);

	for (const dependency of Object.keys(manifest.dependencies ?? {})) {
		if (resolveDependency(resolved, dependency) === null) return null;
	}

	return resolved;
}

function realpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
