import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { GitFileStatus, GitStatus, GitStatusFile } from "@gentle-shell/protocol";
import { resolveInWorkspace } from "./workspace.ts";

/**
 * Git reads for the inspector.
 *
 * Everything goes through `git -C <workspace>`; the bridge never parses the index itself. Paths are
 * validated against the workspace root first, so a pathspec cannot name anything outside it, and
 * `--` keeps a path from being read as an option. A directory that is not a repository is a normal
 * answer (`isRepo: false`), not an error: the UI shows an honest empty state instead of a failure.
 *
 * Every command runs from the workspace, and `--relative` keeps the reported paths workspace-relative
 * too, so the same strings work whether the workspace is a repository root or a subdirectory of one.
 */

const MAX_BUFFER = 32 * 1024 * 1024;
/** Render cap for an untracked file; a generated file should not become a megabyte of text. */
const MAX_DIFF_BYTES = 200 * 1024;

const exec = promisify(execFile);

async function git(root: string, args: readonly string[]): Promise<string> {
	const { stdout } = await exec("git", ["-C", root, ...args], { maxBuffer: MAX_BUFFER, windowsHide: true });
	return stdout;
}

export async function gitStatus(root: string): Promise<GitStatus> {
	const base = await repoRoot(root);
	if (base === null) return { isRepo: false, branch: "", files: [] };

	const branch = await git(base, ["rev-parse", "--abbrev-ref", "HEAD"])
		.then((stdout) => stdout.trim())
		.catch(() => "");
	const entries = await readPorcelain(base);
	const counts = await readCounts(base);

	const files: GitStatusFile[] = [];
	for (const entry of entries) {
		const status = statusOf(entry.index, entry.worktree);
		if (status === null) continue;
		const count = counts.get(entry.path);
		files.push({
			path: entry.path,
			status,
			staged: entry.index !== " " && entry.index !== "?",
			...(count === undefined ? {} : { additions: count.additions, deletions: count.deletions }),
		});
	}
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	// A detached HEAD is not a branch name; reporting the literal "HEAD" would read as one.
	return { isRepo: true, branch: branch === "HEAD" ? "" : branch, files };
}

export async function gitDiff(root: string, relativePath: string): Promise<string> {
	const target = await resolveInWorkspace(root, relativePath, { requireExists: false });
	const base = await repoRoot(target.root);
	if (base === null) throw new Error("the workspace is not a git repository");

	const entries = await readPorcelain(base);
	const entry = entries.find((candidate) => candidate.path === target.relative);
	if (entry !== undefined && entry.index === "?") return await untrackedDiff(target.path, target.relative);

	return await trackedDiff(base, target.relative);
}

interface PorcelainEntry {
	readonly path: string;
	readonly index: string;
	readonly worktree: string;
}

/**
 * `git status --porcelain=v1 -z`. Untracked directories stay collapsed: an unexplored
 * `node_modules` is one row in the changes list, not fifty thousand.
 */
async function readPorcelain(root: string): Promise<PorcelainEntry[]> {
	let raw: string;
	try {
		raw = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
	} catch {
		return [];
	}

	const entries: PorcelainEntry[] = [];
	const tokens = raw.split("\0");
	for (let index = 0; index < tokens.length; index += 1) {
		const record = tokens[index] ?? "";
		// "XY <path>": two status letters, a space, then the path.
		if (record.length < 4) continue;
		const entry: PorcelainEntry = {
			path: record.slice(3).replace(/\/$/, ""),
			index: record.charAt(0),
			worktree: record.charAt(1),
		};
		if (isRename(entry)) {
			// In `-z` a rename is written as `<new>\0<original>\0`, so the next token is the source.
			index += 1;
		}
		entries.push(entry);
	}
	return entries;
}

function isRename(entry: PorcelainEntry): boolean {
	return entry.index === "R" || entry.index === "C" || entry.worktree === "R" || entry.worktree === "C";
}

/** Line counts per path, summing the index and the working tree so both sides of a change show. */
async function readCounts(root: string): Promise<Map<string, { additions: number; deletions: number }>> {
	const counts = new Map<string, { additions: number; deletions: number }>();
	await collectCounts(root, ["diff", "--numstat", "-z", "--relative"], counts);
	await collectCounts(root, ["diff", "--cached", "--numstat", "-z", "--relative"], counts);
	return counts;
}

async function collectCounts(
	root: string,
	args: readonly string[],
	into: Map<string, { additions: number; deletions: number }>,
): Promise<void> {
	let raw: string;
	try {
		raw = await git(root, args);
	} catch {
		return;
	}

	const tokens = raw.split("\0");
	for (let index = 0; index < tokens.length; index += 1) {
		const record = tokens[index] ?? "";
		if (record.length === 0) continue;
		const [added = "", removed = "", ...rest] = record.split("\t");
		// Binary files report "-" instead of a count, so they simply carry no numbers.
		if (added === "-" || removed === "-") continue;
		const count = { additions: Number(added), deletions: Number(removed) };
		const path = rest.join("\t");
		if (path.length > 0) {
			add(into, path, count);
			continue;
		}
		// A rename carries no path in the record; the two following tokens are its paths.
		for (const candidate of [tokens[index + 1], tokens[index + 2]]) {
			if (candidate !== undefined && candidate.length > 0) add(into, candidate, count);
		}
		index += 2;
	}
}

function add(
	into: Map<string, { additions: number; deletions: number }>,
	path: string,
	count: { additions: number; deletions: number },
): void {
	const existing = into.get(path);
	into.set(path, {
		additions: (existing?.additions ?? 0) + count.additions,
		deletions: (existing?.deletions ?? 0) + count.deletions,
	});
}

function statusOf(index: string, worktree: string): GitFileStatus | null {
	if (index === "?") return "untracked";
	if (index === "!") return null;
	if (index === "R" || worktree === "R" || index === "C" || worktree === "C") return "renamed";
	if (index === "D" || worktree === "D") return "deleted";
	if (index === "A" || worktree === "A") return "added";
	return "modified";
}

/** Everything `HEAD` knows, so a staged change and a working-tree change compare against one base. */
async function trackedDiff(root: string, relativePath: string): Promise<string> {
	const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])
		.then((stdout) => stdout.trim())
		.catch(() => "");

	if (head.length > 0) return await git(root, ["diff", "HEAD", "--", relativePath]);
	// A repository with no commit yet has no HEAD: compare the index, then the working tree.
	const staged = await git(root, ["diff", "--cached", "--", relativePath]).catch(() => "");
	const working = await git(root, ["diff", "--", relativePath]).catch(() => "");
	return `${staged}${working}`;
}

/** Render a file git does not track as if it had just been added. */
async function untrackedDiff(path: string, relativePath: string): Promise<string> {
	const stats = await stat(path).catch(() => null);
	if (stats?.isFile() !== true) return `# untracked directory: ${relativePath}\n`;

	const raw = await readFile(path).catch(() => Buffer.alloc(0));
	const text = raw.subarray(0, MAX_DIFF_BYTES).toString("utf8");
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();

	return [
		`diff --git a/${relativePath} b/${relativePath}`,
		"new file mode 100644",
		"--- /dev/null",
		`+++ b/${relativePath}`,
		`@@ -0,0 +1,${lines.length} @@`,
		...lines.map((line) => `+${line}`),
		...(text.length >= MAX_DIFF_BYTES ? ["+… truncated at 200 KiB"] : []),
		"",
	].join("\n");
}

/** Real workspace root when it is inside a repository work tree, `null` otherwise. */
async function repoRoot(root: string): Promise<string | null> {
	const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => "");
	if (inside.trim() !== "true") return null;
	return await resolveInWorkspace(root, "").then(
		(target) => target.root,
		() => null,
	);
}
