import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { listTree, readFileIn } from "../src/workspace.ts";

const KIB = 1024;

/** A throwaway workspace that removes itself when the test ends. */
function scratch(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "gentle-workspace-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("lists directories before files with workspace-relative paths", async (t) => {
	const root = scratch(t);
	mkdirSync(join(root, "src"));
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "readme.md"), "hi");
	writeFileSync(join(root, "package.json"), "{}");
	writeFileSync(join(root, "src", "main.ts"), "export {};\n");

	const top = await listTree(root);
	assert.deepEqual(
		top.map((entry) => [entry.name, entry.kind, entry.path]),
		[
			["docs", "dir", "docs"],
			["src", "dir", "src"],
			["package.json", "file", "package.json"],
			["readme.md", "file", "readme.md"],
		],
	);

	assert.deepEqual(await listTree(root, "src"), [{ name: "main.ts", path: "src/main.ts", kind: "file" }]);
});

test("caps one directory listing at 400 entries", async (t) => {
	const root = scratch(t);
	const many = join(root, "many");
	mkdirSync(many);
	for (let index = 0; index < 420; index += 1) {
		writeFileSync(join(many, `file-${String(index).padStart(3, "0")}.txt`), "");
	}

	const entries = await listTree(root, "many");
	assert.equal(entries.length, 400);
	assert.equal(entries[0]?.name, "file-000.txt");
	assert.equal(entries.at(-1)?.name, "file-399.txt");
	assert.ok(entries.every((entry) => entry.kind === "file"));
});

test("rejects traversal, absolute paths and symlinks that leave the workspace", async (t) => {
	const root = scratch(t);
	const outside = scratch(t);
	writeFileSync(join(outside, "secret.txt"), "secret");
	mkdirSync(join(outside, "folder"));
	writeFileSync(join(outside, "folder", "inside.txt"), "secret");
	writeFileSync(join(root, "readme.md"), "hi");
	symlinkSync(join(outside, "secret.txt"), join(root, "link-file.txt"));
	symlinkSync(join(outside, "folder"), join(root, "link-folder"));
	symlinkSync(join(root, "readme.md"), join(root, "link-inside.md"));

	await assert.rejects(() => listTree(root, ".."), /path escapes the workspace/);
	await assert.rejects(() => listTree(root, outside), /path escapes the workspace/);
	await assert.rejects(() => readFileIn(root, `../${basename(outside)}/secret.txt`), /path escapes the workspace/);
	await assert.rejects(() => readFileIn(root, join(outside, "secret.txt")), /path escapes the workspace/);
	await assert.rejects(() => readFileIn(root, "link-file.txt"), /path escapes the workspace/);
	await assert.rejects(() => listTree(root, "link-folder"), /path escapes the workspace/);
	await assert.rejects(() => readFileIn(root, "link-folder/inside.txt"), /path escapes the workspace/);

	// A link that stays inside the workspace is navigation, not an escape.
	assert.equal((await readFileIn(root, "link-inside.md")).content, "hi");
	const listed = await listTree(root);
	assert.equal(listed.find((entry) => entry.name === "link-folder")?.kind, "dir");
});

test("caps a read at 200 KiB and reports the truncation", async (t) => {
	const root = scratch(t);
	writeFileSync(join(root, "small.txt"), "hello\n");
	assert.deepEqual(await readFileIn(root, "small.txt"), { content: "hello\n", truncated: false });

	writeFileSync(join(root, "big.txt"), "a".repeat(250 * KIB));
	const big = await readFileIn(root, "big.txt");
	assert.equal(big.truncated, true);
	assert.equal(big.content.length, 200 * KIB);
	assert.ok(big.content.startsWith("aaaa"));
});

test("refuses a directory read and a missing file", async (t) => {
	const root = scratch(t);
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "small.txt"), "hello\n");

	await assert.rejects(() => readFileIn(root, "src"), /not a file/);
	await assert.rejects(() => readFileIn(root, "missing.txt"), /does not exist/);
	await assert.rejects(() => listTree(root, "small.txt"), /not a directory/);
});
