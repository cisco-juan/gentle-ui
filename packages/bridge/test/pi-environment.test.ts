import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { defaultExtensionCandidates, resolvePiEnvironment } from "../src/pi-environment.ts";

interface FakeFs {
	readonly exists: (path: string) => boolean;
	readonly readFile: (path: string) => string;
	readonly resolveDependency: (root: string, specifier: string) => string | null;
}

/**
 * A fake machine: `files` maps existing paths to contents, and `resolvable` lists the dependencies
 * each package root can resolve.
 */
function fakeMachine(files: Record<string, string>, resolvable: Record<string, readonly string[]> = {}): FakeFs {
	return {
		exists: (path) => Object.hasOwn(files, path),
		readFile: (path) => files[path] ?? "",
		resolveDependency: (root, specifier) =>
			(resolvable[root] ?? []).includes(specifier) ? join(root, "node_modules", specifier, "index.js") : null,
	};
}

function pkg(root: string, options: { name?: string; extensions?: readonly string[]; dependencies?: Record<string, string> } = {}): string {
	return JSON.stringify({
		name: options.name ?? "gentle-pi",
		pi: { extensions: options.extensions ?? ["./extensions"] },
		dependencies: options.dependencies ?? { "@heyhuynhgiabuu/pi-pretty": "0.6.27" },
	});
}

const HOME = "/home/tester";
const CURRENT = join(HOME, ".gentle-shell", "current", "node_modules", "gentle-pi");
const AGENT_NPM = join(HOME, ".gentle-shell", "agent", "npm", "node_modules", "gentle-pi");
const DEP = "@heyhuynhgiabuu/pi-pretty";

test("pins the Gentle Shell environment even without a package", () => {
	const environment = resolvePiEnvironment({ home: HOME, candidates: [], ...fakeMachine({}) });

	assert.deepEqual(environment.args, []);
	assert.equal(environment.extensionPath, null);
	assert.equal(environment.env.PI_CODING_AGENT_DIR, join(HOME, ".gentle-shell", "agent"));
	assert.equal(environment.env.GENTLE_PI_AGENT_HOME, join(HOME, ".gentle-shell", "agent"));
	assert.equal(environment.env.GENTLE_SHELL_USER_PI_HOME, join(HOME, ".pi", "agent"));
	assert.equal(environment.env.GENTLE_SHELL_CONFIG_HOME, join(HOME, ".gentle-shell", "gentle-ai"));
	assert.equal(environment.env.PI_PROGRAM_STATUS_APP, "gentle-shell");
	assert.equal(environment.env.GENTLE_SHELL_INTERACTIVE_HOST, "1");
});

test("passes a package whose declaration and dependencies hold", () => {
	const files = { [join(CURRENT, "package.json")]: pkg(CURRENT) };
	const environment = resolvePiEnvironment({
		home: HOME,
		candidates: [CURRENT],
		...fakeMachine(files, { [CURRENT]: [DEP] }),
	});

	assert.equal(environment.extensionPath, CURRENT);
	assert.deepEqual(environment.args, ["-e", CURRENT]);
});

test("skips a copy whose dependency tree is missing", () => {
	// The npm-installed copy on this machine declares extensions but has no @heyhuynhgiabuu tree, so
	// pi exits 1 when asked to load it. Discovery must fall through, not stop at it.
	const files = {
		[join(AGENT_NPM, "package.json")]: pkg(AGENT_NPM),
		[join(CURRENT, "package.json")]: pkg(CURRENT),
	};
	const environment = resolvePiEnvironment({
		home: HOME,
		candidates: [AGENT_NPM, CURRENT],
		...fakeMachine(files, { [CURRENT]: [DEP] }),
	});

	assert.equal(environment.extensionPath, CURRENT);
});

test("ignores a directory that is not the Gentle Shell package", () => {
	const files = { [join(CURRENT, "package.json")]: pkg(CURRENT, { name: "some-other-package" }) };
	const environment = resolvePiEnvironment({
		home: HOME,
		candidates: [CURRENT],
		...fakeMachine(files, { [CURRENT]: [DEP] }),
	});

	assert.equal(environment.extensionPath, null);
});

test("ignores a package that declares no extensions", () => {
	const files = { [join(CURRENT, "package.json")]: pkg(CURRENT, { extensions: [] }) };
	const environment = resolvePiEnvironment({
		home: HOME,
		candidates: [CURRENT],
		...fakeMachine(files, { [CURRENT]: [DEP] }),
	});

	assert.equal(environment.extensionPath, null);
});

test("an explicit override wins over discovery", () => {
	const explicit = "/opt/gentle-pi";
	const files = { [join(explicit, "package.json")]: pkg(explicit) };
	const environment = resolvePiEnvironment({
		home: HOME,
		extension: explicit,
		candidates: [CURRENT],
		...fakeMachine(files, { [explicit]: [DEP] }),
	});

	assert.equal(environment.extensionPath, explicit);
});

test("default candidates prefer the tree the TUI runs from", () => {
	const candidates = defaultExtensionCandidates(HOME);
	assert.equal(candidates[0], CURRENT);
	assert.ok(candidates.includes(AGENT_NPM));
});
