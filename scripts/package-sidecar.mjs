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
 * directory outside the worktree and is moved into place only once it is complete.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	createWriteStream,
	existsSync,
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
import { dirname, join, relative } from "node:path";
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
	const entryInsideArchive = join(`node-v${NODE_VERSION}-${platform.nodeOs}-${platform.nodeArch}`, "bin", platform.binary);

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

	await prepare(platformId, platform, { archiveName, archiveUrl, entryInsideArchive });
}

async function prepare(platformId, platform, { archiveName, archiveUrl, entryInsideArchive }) {
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

		const nodeBinary = join(extracted, entryInsideArchive);
		if (!existsSync(nodeBinary)) fail(`${archiveName} did not contain ${entryInsideArchive}`);
		if (platformId === `${hostPlatform()}-${hostArch()}`) {
			const reported = run(nodeBinary, ["--version"], { label: `check ${archiveName}`, capture: true }).stdout.trim();
			if (reported !== `v${NODE_VERSION}`) fail(`${archiveName} reported "${reported}", expected v${NODE_VERSION}`);
		}

		const payload = stagePayload(scratch);
		assertPayload(payload.dir);

		const staged = join(scratch, "bridge");
		mkdirSync(join(staged, "app"), { recursive: true });
		cpSync(payload.dir, join(staged, "app"), { recursive: true, dereference: true });
		cpSync(nodeBinary, join(staged, platform.target));
		chmodSync(join(staged, platform.target), 0o755);
		writeFileSync(
			join(staged, "manifest.json"),
			`${JSON.stringify(
				{
					nodeVersion: NODE_VERSION,
					platform: platformId,
					arch: platform.nodeArch,
					bridgeVersion: JSON.parse(readFileSync(bridgeManifestPath, "utf8")).version,
				},
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
				`  runtime     node ${NODE_VERSION} (${platformId})\n` +
				`  payload     ${payload.via}\n` +
				`  size        ${megabytes(bundleDir)} MB\n` +
				`  entry       ${relative(process.cwd(), join(bundleDir, "app", "dist", "main.js"))}\n`,
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Stage the bridge with production dependencies only. `pnpm deploy` is the supported path because it
 * resolves the workspace graph itself; the manual path exists for pnpm versions where `deploy` needs a
 * different flag, and drops `workspace:` dependencies because the bridge imports
 * `@gentle-shell/protocol` as types only (nothing from it is loaded at runtime).
 */
function stagePayload(scratch) {
	const attempts = [
		["--filter", "@gentle-shell/bridge", "deploy", "--prod", "--legacy"],
		["--filter", "@gentle-shell/bridge", "deploy", "--prod"],
	];
	for (const [index, args] of attempts.entries()) {
		const target = join(scratch, `payload-${index}`);
		const result = spawnSync("pnpm", [...args, target], { cwd: repoRoot, encoding: "utf8", shell: needsShell() });
		if (result.status === 0 && existsSync(join(target, "dist", "main.js"))) {
			return { dir: target, via: `pnpm ${args.join(" ")}` };
		}
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
	run("pnpm", ["--dir", dir, "install", "--prod", "--ignore-scripts", "--no-frozen-lockfile"], {
		label: "install production dependencies",
	});
	return { dir, via: "manual staging plus pnpm install --prod" };
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

await main();
