import { open, readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { WorkspaceFileContent, WorkspaceTreeEntry } from "@gentle-shell/protocol";

/**
 * Workspace file access for the inspector.
 *
 * The bridge is a local process with the user's privileges and the UI asks it to read arbitrary
 * paths, so the workspace root is the whole security boundary. Every request is resolved twice: once
 * lexically (which also rejects `..` and absolute paths that leave the root) and once through
 * `realpath`, so a symlink inside the workspace cannot be used as a door to the rest of the disk.
 * `realpath` is the check that matters; the lexical pass keeps a stable answer for paths that do not
 * exist on disk yet, such as a file git already deleted.
 */

/** A single directory listing never grows past this many entries. */
export const MAX_TREE_ENTRIES = 400;
/** Reads stop here; the UI shows the prefix and says the file was truncated. */
export const MAX_READ_BYTES = 200 * 1024;

/** The one error a path outside the root may produce, so tests and the UI can match on it. */
export const ESCAPE_ERROR = "path escapes the workspace";

export interface WorkspaceTarget {
	/** Real path of the workspace root. */
	readonly root: string;
	/** Real path of the resolved target, or the lexical path when it does not exist. */
	readonly path: string;
	/** Target relative to the root, with `/` separators. Empty for the root itself. */
	readonly relative: string;
	readonly exists: boolean;
}

export interface ResolveOptions {
	/** Defaults to true. Git needs false: a deleted file has no path on disk. */
	readonly requireExists?: boolean;
}

/**
 * Resolve a workspace-relative path, refusing anything that lands outside the root.
 *
 * Throws `path escapes the workspace` for traversal, for absolute paths outside the root, and for a
 * symlink whose target is outside the root, including a symlinked directory in the middle of a path.
 */
export async function resolveInWorkspace(
	root: string,
	relativePath: string,
	options: ResolveOptions = {},
): Promise<WorkspaceTarget> {
	const requireExists = options.requireExists ?? true;
	if (relativePath.includes("\0")) throw new Error(ESCAPE_ERROR);

	const base = await realpath(root).catch(() => null);
	if (base === null) throw new Error(`workspace is not readable: ${root}`);

	const candidate = resolve(base, relativePath);
	if (candidate === base) return { root: base, path: base, relative: "", exists: true };
	if (!inside(base, candidate)) throw new Error(ESCAPE_ERROR);

	// The parent must exist and stay inside the root. This is what stops a symlinked directory from
	// carrying a read out of the workspace, while still letting a deleted file be named.
	const parent = await realpath(dirname(candidate)).catch(() => null);
	if (parent === null) {
		if (requireExists) throw new Error(`path does not exist in the workspace: ${display(relativePath)}`);
		return { root: base, path: candidate, relative: relativeOf(base, candidate), exists: false };
	}
	if (!inside(base, parent)) throw new Error(ESCAPE_ERROR);

	const path = join(parent, basename(candidate));
	const real = await realpath(path).catch(() => null);
	if (real === null) {
		if (requireExists) throw new Error(`path does not exist in the workspace: ${display(relativePath)}`);
		return { root: base, path, relative: relativeOf(base, path), exists: false };
	}
	if (!inside(base, real)) throw new Error(ESCAPE_ERROR);

	return { root: base, path: real, relative: relativeOf(base, real), exists: true };
}

export async function listTree(root: string, relativePath = ""): Promise<WorkspaceTreeEntry[]> {
	const target = await resolveInWorkspace(root, relativePath);
	const stats = await stat(target.path);
	if (!stats.isDirectory()) throw new Error(`not a directory: ${display(relativePath)}`);

	const entries = await readdir(target.path, { withFileTypes: true });
	const directories: WorkspaceTreeEntry[] = [];
	const files: WorkspaceTreeEntry[] = [];
	for (const entry of entries) {
		const kind = await kindOf(join(target.path, entry.name), entry);
		if (kind === null) continue;
		const item: WorkspaceTreeEntry = { name: entry.name, path: joinRelative(target.relative, entry.name), kind };
		(kind === "dir" ? directories : files).push(item);
	}

	directories.sort(byName);
	files.sort(byName);
	return [...directories, ...files].slice(0, MAX_TREE_ENTRIES);
}

export async function readFileIn(root: string, relativePath: string): Promise<WorkspaceFileContent> {
	if (relativePath.trim().length === 0) throw new Error("a file path is required");
	const target = await resolveInWorkspace(root, relativePath);
	const stats = await stat(target.path);
	if (!stats.isFile()) throw new Error(`not a file: ${display(relativePath)}`);

	const handle = await open(target.path, "r");
	try {
		// One byte past the cap is enough to know whether the file continues.
		const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const truncated = bytesRead > MAX_READ_BYTES;
		const end = truncated ? trimPartialUtf8(buffer, MAX_READ_BYTES) : bytesRead;
		return { content: buffer.subarray(0, end).toString("utf8"), truncated };
	} finally {
		await handle.close();
	}
}

async function kindOf(path: string, entry: Dirent): Promise<"file" | "dir" | null> {
	if (entry.isDirectory()) return "dir";
	if (entry.isFile()) return "file";
	if (!entry.isSymbolicLink()) return null;
	// Follow the link only to classify it; every read and listing resolves it again through realpath.
	const stats = await stat(path).catch(() => null);
	if (stats === null) return null;
	if (stats.isDirectory()) return "dir";
	return stats.isFile() ? "file" : null;
}

/** Drop a trailing multi-byte character the cap cut in half, so the tail is not U+FFFD. */
function trimPartialUtf8(buffer: Buffer, end: number): number {
	let back = 0;
	while (back < 3 && end - back - 1 >= 0 && isContinuationByte(buffer[end - back - 1] ?? 0)) back += 1;

	if (back === 0) {
		const last = buffer[end - 1] ?? 0;
		return last >= 0xc0 && last <= 0xf7 ? end - 1 : end;
	}

	const leadIndex = end - back - 1;
	const lead = buffer[leadIndex] ?? 0;
	const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0;
	if (needed === 0) return end - back;
	return needed === back + 1 ? end : leadIndex;
}

function isContinuationByte(value: number): boolean {
	return value >= 0x80 && value <= 0xbf;
}

function byName(left: WorkspaceTreeEntry, right: WorkspaceTreeEntry): number {
	return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function inside(base: string, candidate: string): boolean {
	return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : base + sep);
}

function relativeOf(base: string, path: string): string {
	return relative(base, path).split(sep).join("/");
}

function joinRelative(parent: string, name: string): string {
	return parent.length === 0 ? name : `${parent}/${name}`;
}

function display(relativePath: string): string {
	const trimmed = relativePath.replaceAll("\0", "").trim();
	return trimmed.length === 0 ? "." : trimmed;
}
