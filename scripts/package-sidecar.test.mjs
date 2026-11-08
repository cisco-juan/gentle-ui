// The decisions `package-sidecar.mjs` makes from plain lists: where the runtime sits inside a Node
// archive, whether a staged dependency tree still hides symlinks, and what the manifest records.
//
// Nothing here downloads an archive, runs pnpm or touches the worktree: those steps are the script's
// I/O, exercised by running `pnpm package:sidecar`. What is tested is the reasoning, so a Windows
// archive layout or a regression back to pnpm's isolated (symlinked) layout is caught without a
// release build.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildManifest, chooseNodeEntry, firstSymlink, topLevelEntries } from "./package-sidecar.mjs";

/** A realistic slice of `node-v22.23.2-linux-x64.tar.gz`: the binary next to the npm tree. */
const UNIX_ARCHIVE = [
	"node-v22.23.2-linux-x64/CHANGELOG.md",
	"node-v22.23.2-linux-x64/README.md",
	"node-v22.23.2-linux-x64/bin/node",
	"node-v22.23.2-linux-x64/bin/npm",
	"node-v22.23.2-linux-x64/include/node/node.h",
	"node-v22.23.2-linux-x64/lib/node_modules/npm/bin/node-gyp-bin/node",
	"node-v22.23.2-linux-x64/lib/node_modules/npm/package.json",
];

/** The official Windows zip puts `node.exe` at the root of the versioned directory, not in `bin/`. */
const WINDOWS_ARCHIVE = [
	"node-v22.23.2-win-x64/CHANGELOG.md",
	"node-v22.23.2-win-x64/README.md",
	"node-v22.23.2-win-x64/node.exe",
	"node-v22.23.2-win-x64/node_modules/npm/bin/node-gyp-bin/node.cmd",
	"node-v22.23.2-win-x64/node_modules/npm/package.json",
];

test("chooseNodeEntry finds bin/node in a unix archive", () => {
	assert.equal(chooseNodeEntry(UNIX_ARCHIVE, "node"), "node-v22.23.2-linux-x64/bin/node");
});

test("chooseNodeEntry finds node.exe at the root of a windows archive", () => {
	assert.equal(chooseNodeEntry(WINDOWS_ARCHIVE, "node.exe"), "node-v22.23.2-win-x64/node.exe");
});

test("chooseNodeEntry accepts an archive without a versioned root directory", () => {
	assert.equal(chooseNodeEntry(["bin/node", "bin/npm"], "node"), "bin/node");
	assert.equal(chooseNodeEntry(["node.exe", "npm.cmd"], "node.exe"), "node.exe");
});

test("chooseNodeEntry prefers the shallowest match when the tree repeats the name", () => {
	const entries = [
		"node-v22.23.2-linux-x64/lib/node_modules/npm/node_modules/node/bin/node",
		"node-v22.23.2-linux-x64/bin/node",
	];
	assert.equal(chooseNodeEntry(entries, "node"), "node-v22.23.2-linux-x64/bin/node");
});

test("chooseNodeEntry returns null when the archive holds no runtime", () => {
	assert.equal(chooseNodeEntry(UNIX_ARCHIVE, "node.exe"), null);
	assert.equal(chooseNodeEntry(WINDOWS_ARCHIVE, "node"), null);
	assert.equal(chooseNodeEntry([], "node"), null);
});

test("topLevelEntries reports what the archive actually contains", () => {
	assert.deepEqual(topLevelEntries(UNIX_ARCHIVE), ["node-v22.23.2-linux-x64"]);
	assert.deepEqual(topLevelEntries(["a/file", "b/file", "a/other"]), ["a", "b"]);
	assert.deepEqual(topLevelEntries([]), []);
});

test("firstSymlink reports the first link in staged paths", () => {
	const staged = ["app/dist/main.js", "app/node_modules/ws/index.js", "app/node_modules/ws/link"];
	const link = (path) => path.endsWith("/link");
	assert.equal(firstSymlink(staged, link), "app/node_modules/ws/link");
});

test("firstSymlink is null when every staged path is a real entry", () => {
	assert.equal(firstSymlink(["app/dist/main.js", "app/node_modules/ws/index.js"], () => false), null);
	assert.equal(firstSymlink([]), null);
});

test("firstSymlink detects a real symlink on disk", () => {
	const scratch = mkdtempSync(join(tmpdir(), "gentle-sidecar-test-"));
	try {
		const real = join(scratch, "real.txt");
		const link = join(scratch, "link.txt");
		writeFileSync(real, "payload\n");
		symlinkSync(real, link);
		assert.equal(firstSymlink([real, link]), link);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("buildManifest records the packed runtime, the tree shape and the file count", () => {
	const manifest = buildManifest({
		nodeVersion: "22.23.2",
		platformId: "linux-x64",
		arch: "x64",
		bridgeVersion: "0.1.0",
		files: 15432,
	});
	assert.deepEqual(manifest, {
		nodeVersion: "22.23.2",
		platform: "linux-x64",
		arch: "x64",
		bridgeVersion: "0.1.0",
		linkFree: true,
		files: 15432,
	});
	assert.equal(typeof manifest.files, "number");
	assert.equal(Number.isInteger(manifest.files), true);
	assert.equal(typeof manifest.linkFree, "boolean");
	assert.equal(manifest.linkFree, true);
});
