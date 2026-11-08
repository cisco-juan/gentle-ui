import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiff, gitStatus } from "../src/git.ts";

/** A throwaway directory that removes itself when the test ends. */
function scratch(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "gentle-git-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function git(root: string, ...args: readonly string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

/** A repository with one committed file, so `HEAD` exists before the test touches it. */
function repository(t: TestContext): string {
	const root = scratch(t);
	git(root, "init", "--initial-branch=main", "--quiet");
	git(root, "config", "user.email", "tests@gentle-shell.example");
	git(root, "config", "user.name", "Gentle Shell tests");
	git(root, "config", "commit.gpgsign", "false");
	git(root, "config", "core.autocrlf", "false");
	writeFileSync(join(root, "base.txt"), "one\ntwo\n");
	git(root, "add", "base.txt");
	git(root, "commit", "--message", "base", "--quiet");
	return root;
}

test("reports a clean repository with its branch and no files", async (t) => {
	const root = repository(t);

	const status = await gitStatus(root);
	assert.equal(status.isRepo, true);
	assert.equal(status.branch, "main");
	assert.deepEqual(status.files, []);
});

test("reports a modified file with its line counts", async (t) => {
	const root = repository(t);
	writeFileSync(join(root, "base.txt"), "one\nthree\nfour\n");

	const status = await gitStatus(root);
	assert.deepEqual(status.files, [{ path: "base.txt", status: "modified", staged: false, additions: 2, deletions: 1 }]);
});

test("marks a staged change as staged", async (t) => {
	const root = repository(t);
	writeFileSync(join(root, "base.txt"), "one\ntwo\nthree\n");
	git(root, "add", "base.txt");

	const status = await gitStatus(root);
	assert.deepEqual(status.files, [{ path: "base.txt", status: "modified", staged: true, additions: 1, deletions: 0 }]);
});

test("lists an untracked file and renders it as an all-added diff", async (t) => {
	const root = repository(t);
	writeFileSync(join(root, "notes.md"), "# notes\nline two\n");

	const status = await gitStatus(root);
	assert.deepEqual(status.files, [{ path: "notes.md", status: "untracked", staged: false }]);

	const diff = await gitDiff(root, "notes.md");
	assert.match(diff, /^diff --git a\/notes\.md b\/notes\.md$/m);
	assert.match(diff, /^--- \/dev\/null$/m);
	assert.match(diff, /^\+\+\+ b\/notes\.md$/m);
	assert.match(diff, /^@@ -0,0 \+1,2 @@$/m);
	assert.deepEqual(
		diff
			.split("\n")
			.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
			.map((line) => line.slice(1)),
		["# notes", "line two"],
	);
});

test("returns a unified diff for a modified file", async (t) => {
	const root = repository(t);
	writeFileSync(join(root, "base.txt"), "one\nchanged\n");

	const diff = await gitDiff(root, "base.txt");
	assert.match(diff, /^--- a\/base\.txt$/m);
	assert.match(diff, /^\+\+\+ b\/base\.txt$/m);
	assert.match(diff, /^-two$/m);
	assert.match(diff, /^\+changed$/m);
});

test("reports a staged deletion and still diffs the missing path", async (t) => {
	const root = repository(t);
	git(root, "rm", "--quiet", "base.txt");

	const status = await gitStatus(root);
	assert.deepEqual(status.files, [{ path: "base.txt", status: "deleted", staged: true, additions: 0, deletions: 2 }]);

	const diff = await gitDiff(root, "base.txt");
	assert.match(diff, /^-one$/m);
	assert.match(diff, /^-two$/m);
});

test("returns isRepo false outside a repository instead of throwing", async (t) => {
	const root = scratch(t);

	const status = await gitStatus(root);
	assert.deepEqual(status, { isRepo: false, branch: "", files: [] });
});
