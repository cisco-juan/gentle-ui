#!/usr/bin/env node
/**
 * Prepare the bridge sidecar bundle that a release build packs into the app.
 *
 * The UI is static files, but the bridge is a Node program that spawns `pi --mode rpc`, and a user's
 * machine has no Node. So the bundle carries a Node runtime plus the built bridge with its production
 * dependencies, and Rust starts it at launch. `docs/packaging.md` describes the whole scheme; this
 * script only produces the directory it describes:
 *
 *   apps/desktop/src-tauri/bridge/
 *   ├── node(.exe)              Node runtime for the target platform
 *   ├── app/dist/main.js        packages/bridge build output
 *   ├── app/node_modules/       production dependencies only
 *   └── manifest.json           what was packed, for support
 *
 * Every failure is loud and leaves no partial bundle behind: the work happens in a temporary
 * directory outside the worktree and is moved into place only once it is complete. The dependency tree
 * is installed with pnpm's **hoisted** linker and asserted to be free of symlinks, because Tauri copies
 * `bridge/` as a resource tree and cannot follow the links pnpm's default isolated layout leaves behind.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	createWriteStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { arch as hostArch, platform as hostPlatform, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const PREFIX = "package:sidecar:";
const DIST_BASE = "https://nodejs.org/dist";
/** Pinned on purpose: the runtime users get must not depend on the machine that built the release. */
const DEFAULT_NODE_VERSION = "22.23.2";
const NODE_VERSION = process.env.NODE_SIDECAR_VERSION ?? DEFAULT_NODE_VERSION;
/** Node 22 is the LTS line this app is developed and tested against. */
const SUPPORTED_NODE_MAJOR = 22;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleDir = join(repoRoot, "apps", "desktop", "src-tauri", "bridge");
const bridgePackage = join(repoRoot, "packages", "bridge");
const bridgeManifestPath = join(bridgePackage, "package.json");

/**
 * Platform → Node distribution. The id is `<process.platform>-<process.arch>`, which is also what
 * `--platform` accepts as an override.
 */
const SUPPORTED = {
	"linux-x64": { nodeOs: "linux", nodeArch: "x64", archive: "tar.gz", binary: "node", target: "node" },
	"linux-arm64": { nodeOs: "linux", nodeArch: "arm64", archive: "tar.gz", binary: "node", target: "node" },
	"darwin-x64": { nodeOs: "darwin", nodeArch: "x64", archive: "tar.gz", binary: "node", target: "node" },
	"darwin-arm64": { nodeOs: "darwin", nodeArch: "arm64", archive: "tar.gz", binary: "node", target: "node" },
	"win32-x64": { nodeOs: "win", nodeArch: "x64", archive: "zip", binary: "node.exe", target: "node.exe" },
};

/** Dependencies the bridge resolves at runtime; a bundle without them starts and then dies. */
const REQUIRED_DEPENDENCIES = ["ws", "@earendil-works/pi-coding-agent"];

/**
 * pnpm's default (isolated) layout keeps the dependency tree in `node_modules/.pnpm` and links every
 * package into place. Tauri packs `bridge/` as a resource tree and cannot follow those links, so the
 * release build fails with "resource path '<...>/json-schema-to-ts' doesn't exist". A hoisted install
 * writes plain directories and files instead, which is the only shape the bundler can copy.
 */
const HOISTED_INSTALL = "--node-linker=hoisted";

async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		printUsage();
		return;
	}

	const platformId = option(argv, "--platform") ?? `${hostPlatform()}-${hostArch()}`;
	const platform = SUPPORTED[platformId];
	if (platform === undefined) failUnsupported(platformId);

	if (!/^\d+\.\d+\.\d+$/.test(NODE_VERSION) || Number(NODE_VERSION.split(".")[0]) !== SUPPORTED_NODE_MAJOR) {
		fail(`NODE_SIDECAR_VERSION must be a ${SUPPORTED_NODE_MAJOR}.x.y release, got "${NODE_VERSION}"`);
	}

	const archiveName = `node-v${NODE_VERSION}-${platform.nodeOs}-${platform.nodeArch}.${platform.archive}`;
	const archiveUrl = `${DIST_BASE}/v${NODE_VERSION}/${archiveName}`;

	if (argv.includes("--plan")) {
		// Resolution without touching the network: what would be downloaded and where it would land.
		process.stdout.write(
			`${PREFIX} plan\n` +
				`  platform    ${platformId}\n` +
				`  runtime     ${archiveUrl}\n` +
				`  checksums   ${DIST_BASE}/v${NODE_VERSION}/SHASUMS256.txt\n` +
				`  binary      ${show(join(bundleDir, platform.target))}\n` +
				`  entry       app/dist/main.js\n`,
		);
		return;
	}

	await prepare(platformId, platform, { archiveName, archiveUrl });
}

async function prepare(platformId, platform, { archiveName, archiveUrl }) {
	const scratch = mkdtempSync(join(tmpdir(), "gentle-sidecar-"));
	process.stdout.write(`${PREFIX} working in ${scratch}\n`);

	try {
		const archivePath = join(scratch, archiveName);
		await download(archiveUrl, archivePath);
		await verifyChecksum(archivePath, archiveName);

		const extracted = join(scratch, "node");
		mkdirSync(extracted, { recursive: true });
		// bsdtar (shipped with Windows 10+ and macOS) reads both tar.gz and zip, so one call covers
		// every platform without a native unzip dependency.
		run("tar", ["-xf", archivePath, "-C", extracted], { label: `extract ${archiveName}` });

		// The archive layout is not uniform: unix tarballs put the runtime in `bin/`, the official
		// Windows zip puts `node.exe` at the root of the versioned directory. Search for it instead of
		// trusting one path, and report what was found.
		const entries = listFiles(extracted);
		const entry = chooseNodeEntry(entries, platform.binary);
		if (entry === null) failMissingRuntime(archiveName, platform.binary, entries);
		process.stdout.write(`${PREFIX} found runtime ${entry} inside ${archiveName}\n`);

		const nodeBinary = join(extracted, ...entry.split("/"));
		if (!existsSync(nodeBinary)) fail(`${archiveName} listed ${entry} but it is not on disk after extraction`);
		if (platformId === `${hostPlatform()}-${hostArch()}`) {
			const reported = run(nodeBinary, ["--version"], { label: `check ${archiveName}`, capture: true }).stdout.trim();
			if (reported !== `v${NODE_VERSION}`) fail(`${archiveName} reported "${reported}", expected v${NODE_VERSION}`);
		}

		const payload = stagePayload(scratch);
		assertPayload(payload.dir);
		const payloadTree = inspectTree(payload.dir);
		if (payloadTree.firstLink !== null) {
			fail(
				`the production install left a symlink behind: ${show(payloadTree.firstLink)}\n` +
					`  Tauri copies bridge/ as a resource tree and cannot follow links, so a bundle like this one\n` +
					`  fails the release build with "resource path ... doesn't exist". No bundle was produced.`,
			);
		}

		const staged = join(scratch, "bridge");
		mkdirSync(join(staged, "app"), { recursive: true });
		cpSync(payload.dir, join(staged, "app"), { recursive: true, dereference: true });
		cpSync(nodeBinary, join(staged, platform.target));
		chmodSync(join(staged, platform.target), 0o755);

		// The bundle is what ships, so it is inspected as a whole: the copy above dereferences links, and
		// this is the assertion that says so on the tree Tauri will actually read.
		const bundleTree = inspectTree(join(staged, "app"));
		if (bundleTree.firstLink !== null) {
			fail(
				`the staged bundle still contains a symlink: ${show(bundleTree.firstLink)}\n` +
					`  Tauri copies bridge/ as a resource tree and cannot follow links. No bundle was produced.`,
			);
		}

		writeFileSync(
			join(staged, "manifest.json"),
			`${JSON.stringify(
				buildManifest({
					nodeVersion: NODE_VERSION,
					platformId,
					arch: platform.nodeArch,
					bridgeVersion: JSON.parse(readFileSync(bridgeManifestPath, "utf8")).version,
					files: bundleTree.files,
				}),
				null,
				2,
			)}\n`,
		);

		// Replace the previous bundle only once the new one is complete. The tracked marker stays: it is
		// what makes the `bundle.resources` glob match before the first release build.
		const marker = join(bundleDir, ".gitkeep");
		if (existsSync(marker)) cpSync(marker, join(staged, ".gitkeep"));
		rmSync(bundleDir, { recursive: true, force: true });
		move(staged, bundleDir);

		process.stdout.write(
			`${PREFIX} done\n` +
				`  bundle      ${show(bundleDir)}\n` +
				`  runtime     node ${NODE_VERSION} (${platformId}) from ${entry}\n` +
				`  payload     ${payload.via}\n` +
				`  links       none: ${bundleTree.files} real files and directories, no symlinks (Tauri-safe)\n` +
				`  size        ${megabytes(bundleDir)} MB\n` +
				`  entry       ${relative(process.cwd(), join(bundleDir, "app", "dist", "main.js"))}\n`,
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Stage the bridge with production dependencies only, and with a tree Tauri can copy.
 *
 * `pnpm deploy` is the supported way to resolve the workspace graph: it pins every version from the
 * workspace lockfile. Its default (isolated) layout is a forest of symlinks into `node_modules/.pnpm`,
 * which the bundler cannot follow, so the deployed target is then re-installed in place with the
 * hoisted linker. Asking `deploy` for `--node-linker=hoisted` directly is not an option: that performs
 * a *workspace-wide* production install, which prunes the devDependencies of the checkout running it
 * (observed: the desktop's `@tauri-apps/cli` and the bridge's `typescript` disappeared, so the
 * preceding `pnpm build` of a release run would have no vite either). `deploy --legacy` is not
 * attempted for the same reason.
 *
 * The manual path is the fallback when `deploy` is unavailable on the installed pnpm: it drops
 * `workspace:` dependencies because the bridge imports `@gentle-shell/protocol` as types only (nothing
 * from it is loaded at runtime) and installs hoisted from a `.npmrc` in the staging directory.
 */
function stagePayload(scratch) {
	const target = join(scratch, "payload-deploy");
	const deployArgs = ["--filter", "@gentle-shell/bridge", "deploy", "--prod"];
	const result = spawnSync("pnpm", [...deployArgs, target], { cwd: repoRoot, encoding: "utf8", shell: needsShell() });
	if (result.status === 0 && existsSync(join(target, "dist", "main.js"))) {
		// Same resolved versions as the deploy, relaid out as real directories and files. The lockfile
		// the deploy wrote is what pins them, so this is a re-layout, not a fresh resolution.
		run("pnpm", ["--dir", target, "install", "--prod", "--ignore-scripts", HOISTED_INSTALL], {
			label: "rewrite the deployed payload as real files (hoisted link)",
		});
		return { dir: target, via: `pnpm ${deployArgs.join(" ")}, then ${HOISTED_INSTALL} in the target` };
	}

	process.stdout.write(`${PREFIX} pnpm deploy unavailable here; staging the payload by hand\n`);
	run("pnpm", ["--filter", "@gentle-shell/bridge", "build"], { label: "build the bridge" });
	const dir = join(scratch, "payload-manual");
	mkdirSync(dir, { recursive: true });
	cpSync(join(bridgePackage, "dist"), join(dir, "dist"), { recursive: true });
	const manifest = JSON.parse(readFileSync(bridgeManifestPath, "utf8"));
	delete manifest.devDependencies;
	for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
		if (String(specifier).startsWith("workspace:")) delete manifest.dependencies[name];
	}
	manifest.private = true;
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	// The config file states the linker the flag already asks for, so a pnpm that ignores the flag
	// still installs a tree the bundler can copy. It is removed again: it is not payload.
	writeFileSync(join(dir, ".npmrc"), `node-linker=hoisted\n`);
	run("pnpm", ["--dir", dir, "install", "--prod", "--ignore-scripts", "--no-frozen-lockfile", HOISTED_INSTALL], {
		label: "install production dependencies",
	});
	rmSync(join(dir, ".npmrc"), { force: true });
	return { dir, via: `manual staging plus pnpm install --prod ${HOISTED_INSTALL}` };
}

function assertPayload(dir) {
	if (!existsSync(join(dir, "dist", "main.js"))) {
		fail("the staged bridge has no dist/main.js; run `pnpm --filter @gentle-shell/bridge build`");
	}
	for (const dependency of REQUIRED_DEPENDENCIES) {
		const manifest = join(dir, "node_modules", ...dependency.split("/"), "package.json");
		if (!existsSync(manifest)) {
			fail(`the staged bridge cannot resolve ${dependency}; the bundle would start and then crash`);
		}
	}
}

/**
 * Every file and symlink under `root`, relative and POSIX-separated. Links are entries, not doors: the
 * walk never follows one, because whether any exist is exactly what the caller needs to know.
 */
function listFiles(root) {
	const entries = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			entries.push(relative(root, full).split(sep).join("/"));
		}
	};
	walk(root);
	return entries;
}

/**
 * The runtime inside an extracted Node archive, or null when the archive does not have it.
 *
 * Unix tarballs ship `bin/node`; the official Windows zip ships `node.exe` at the root of the
 * versioned directory. Both are searched for by shape rather than assumed, and the shallowest match
 * wins so a `bin/node` repeated inside the bundled npm tree cannot be mistaken for the runtime.
 */
export function chooseNodeEntry(entries, binary) {
	const wanted = binary === "node.exe" ? "node.exe" : "bin/node";
	const matches = entries
		.map((entry) => String(entry).replace(/\\/g, "/"))
		.filter((entry) => entry === wanted || entry.endsWith(`/${wanted}`));
	matches.sort((left, right) => depth(left) - depth(right) || left.localeCompare(right));
	return matches[0] ?? null;
}

/** The archive's top-level entries, which is what a human needs to see when nothing matched. */
export function topLevelEntries(entries) {
	const tops = new Set();
	for (const entry of entries) {
		const [top] = String(entry).replace(/\\/g, "/").split("/");
		if (top !== undefined && top !== "") tops.add(top);
	}
	return [...tops].sort();
}

/** The first path that is a symlink, or null when every path is a real file or directory. */
export function firstSymlink(paths, isLink = isSymlink) {
	for (const path of paths) {
		if (isLink(path)) return path;
	}
	return null;
}

function isSymlink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		// A link whose target is missing still has to be reported, and lstat does not follow it, so a
		// throw here means the entry vanished mid-walk rather than that it is not a link.
		return false;
	}
}

/** File count and the first symlink of a staged tree, for the assertion and the manifest. */
function inspectTree(root) {
	const entries = listFiles(root);
	return { files: entries.length, firstLink: firstSymlink(entries.map((entry) => join(root, ...entry.split("/")))) };
}

/**
 * What the bundle records about itself. `linkFree` and `files` are the two facts a support engineer
 * needs when a packaged app cannot start: whether the tree Tauri packed is the shape it can copy, and
 * how much of it there was.
 */
export function buildManifest({ nodeVersion, platformId, arch, bridgeVersion, files }) {
	return { nodeVersion, platform: platformId, arch, bridgeVersion, linkFree: true, files };
}

function depth(entry) {
	return entry.split("/").length;
}

function failMissingRuntime(archiveName, binary, entries) {
	const tops = topLevelEntries(entries);
	fail(
		`${archiveName} contains no ${binary}, so there is no runtime to bundle.\n` +
			`  top-level entries in the archive: ${tops.length === 0 ? "(none)" : tops.join(", ")}\n` +
			`  run with --plan to see which archive this platform expects`,
	);
}

async function download(url, destination) {
	const response = await fetch(url);
	if (!response.ok) {
		fail(`download failed for ${url}: ${response.status} ${response.statusText}`);
	}
	await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
	const { size } = statSync(destination);
	process.stdout.write(`${PREFIX} downloaded ${url} (${(size / (1024 * 1024)).toFixed(1)} MB)\n`);
}

async function verifyChecksum(archivePath, archiveName) {
	const shasumsUrl = `${DIST_BASE}/v${NODE_VERSION}/SHASUMS256.txt`;
	const response = await fetch(shasumsUrl);
	if (!response.ok) fail(`cannot read ${shasumsUrl}: ${response.status} ${response.statusText}`);
	const expected = (await response.text())
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.find((fields) => fields[1] === archiveName)?.[0];
	if (expected === undefined) fail(`${shasumsUrl} does not list ${archiveName}; refusing to bundle an unverified runtime`);
	const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
	if (actual !== expected.toLowerCase()) fail(`checksum mismatch for ${archiveName}: expected ${expected}, got ${actual}`);
	process.stdout.write(`${PREFIX} verified ${archiveName} against SHASUMS256.txt\n`);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		encoding: "utf8",
		shell: needsShell(),
		stdio: options.capture === true ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error !== undefined) fail(`${options.label ?? command} cannot run: ${result.error.message}`);
	if (result.status !== 0) {
		const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
		fail(
			`${options.label ?? `${command} ${args.join(" ")}`} failed with exit code ${result.status}` +
				(stderr === "" ? "" : `:\n${stderr}`),
		);
	}
	return { stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

/** Node and pnpm are resolved through PATH; on Windows the launchers are .cmd shims. */
function needsShell() {
	return process.platform === "win32";
}

/** The scratch directory may sit on another filesystem than the worktree. */
function move(source, destination) {
	try {
		renameSync(source, destination);
	} catch (error) {
		if (error.code !== "EXDEV") throw error;
		cpSync(source, destination, { recursive: true, dereference: true });
	}
}

function megabytes(path) {
	let total = 0;
	const walk = (current) => {
		const stats = statSync(current);
		if (stats.isDirectory()) {
			for (const entry of readdirSync(current)) walk(join(current, entry));
			return;
		}
		total += stats.size;
	};
	walk(path);
	return (total / (1024 * 1024)).toFixed(1);
}

function show(path) {
	return relative(process.cwd(), path);
}

function option(argv, name) {
	const index = argv.indexOf(name);
	if (index >= 0) {
		const value = argv[index + 1];
		if (value === undefined) fail(`${name} needs a value, for example ${name} linux-x64`);
		return value;
	}
	const prefixed = argv.find((argument) => argument.startsWith(`${name}=`));
	return prefixed === undefined ? null : prefixed.slice(name.length + 1);
}

function failUnsupported(platformId) {
	fail(
		`platform "${platformId}" is not supported, no bundle was produced.\n` +
			`  supported platforms: ${Object.keys(SUPPORTED).join(", ")}\n` +
			`  a bundle can only be produced on (or for) one of these; run this script on a machine or CI\n` +
			`  runner of that platform, or force the target with --platform <id>`,
	);
}

function fail(message) {
	process.stderr.write(`${PREFIX} ${message}\n`);
	process.exit(1);
}

function printUsage() {
	process.stdout.write(
		"Usage: node scripts/package-sidecar.mjs [--platform <id>] [--plan]\n\n" +
			`Produces ${show(bundleDir)}/ for the current platform: a Node runtime, the built bridge\n` +
			"and its production dependencies, plus manifest.json.\n\n" +
			`  --platform <id>  override platform detection (${Object.keys(SUPPORTED).join(", ")})\n` +
			"  --plan           print what would be downloaded without touching the network\n" +
			"  --help           this text\n\n" +
			"Environment:\n" +
			`  NODE_SIDECAR_VERSION  Node ${SUPPORTED_NODE_MAJOR}.x.y runtime to bundle (default ${DEFAULT_NODE_VERSION})\n`,
	);
}

/** Only run when executed: the test file imports the pure helpers above. */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	await main();
}
