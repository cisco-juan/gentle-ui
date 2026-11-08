import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionSummary } from "@gentle-shell/protocol";

/**
 * Session index for the sidebar.
 *
 * Pi has no `list-sessions` RPC, so the bridge reads the session directory itself. Session files are
 * JSONL, one per session, grouped one folder deep by workspace. The scan is deliberately shallow:
 * the header line supplies `cwd`, and every other field comes from a cheap substring hit parsed on
 * demand, so a transcript costs a few `JSON.parse` calls instead of a full parse. Each file also has
 * a byte budget, because these files reach tens of megabytes and every field worth listing lives in
 * the first records. A malformed line is skipped instead of failing the listing, because a session
 * can be read while Pi is still appending to it.
 */

export interface SessionIndexOptions {
	/** Explicit session root. Defaults to `PI_SESSION_DIR` when that is set. */
	readonly sessionDir?: string;
	/** Roots scanned when no explicit root is given. */
	readonly defaultRoots?: readonly string[];
	/** Maximum number of sessions returned, newest first. */
	readonly limit?: number;
	/** Bytes read from the head of one session file. */
	readonly maxScanBytes?: number;
}

const DEFAULT_LIMIT = 200;
/** Session folders are `<root>/--<workspace>--/`, so a couple of levels is plenty. */
const MAX_DEPTH = 3;
/** Title budget for the first user message. */
const TITLE_LIMIT = 80;
/** Files scanned at once. Enough to hide latency, few enough to keep descriptors sane. */
const SCAN_CONCURRENCY = 8;
/** Head budget per file; renamed sessions large enough to bury the name fall back to their first prompt. */
const DEFAULT_MAX_SCAN_BYTES = 1_048_576;

const USER_HINT = '"user"';
const NAME_HINT = 'session_info';
const MODEL_HINT = 'model_change';

/** Where Pi writes sessions when nothing overrides the location. */
export function defaultSessionRoots(): readonly string[] {
	return [join(homedir(), ".gentle-shell", "agent", "sessions"), join(homedir(), ".pi", "agent", "sessions")];
}

export async function listSessions(options: SessionIndexOptions = {}): Promise<SessionSummary[]> {
	const roots = await resolveRoots(options);
	const limit = options.limit ?? DEFAULT_LIMIT;
	const maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;

	const found = (await Promise.all(roots.map((root) => collectSessionFiles(root)))).flat();
	const dated: Array<{ path: string; updatedAt: number }> = [];
	for (const path of found) {
		const stats = await stat(path).catch(() => null);
		if (stats?.isFile() !== true) continue;
		dated.push({ path, updatedAt: Math.round(stats.mtimeMs) });
	}

	dated.sort((left, right) => right.updatedAt - left.updatedAt || left.path.localeCompare(right.path));

	const items = await mapLimit(dated.slice(0, limit), SCAN_CONCURRENCY, async (file) => {
		const scan = await scanSession(file.path, maxScanBytes);
		return {
			path: file.path,
			cwd: scan.cwd,
			title: scan.name ?? scan.firstUser ?? basename(file.path, ".jsonl"),
			updatedAt: file.updatedAt,
			...(scan.model === null ? {} : { model: scan.model }),
		} satisfies SessionSummary;
	});
	return items;
}

/** Run scans with a bounded pool so a large session root is not read one file at a time. */
async function mapLimit<T, R>(items: readonly T[], concurrency: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor++;
			const item = items[index];
			if (index >= items.length || item === undefined) return;
			results[index] = await run(item);
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return results;
}

/** An explicit root (`PI_SESSION_DIR`) replaces the defaults; otherwise only existing roots count. */
async function resolveRoots(options: SessionIndexOptions): Promise<string[]> {
	const explicit = options.sessionDir ?? process.env.PI_SESSION_DIR;
	if (explicit !== undefined && explicit.trim().length > 0) return [explicit];

	const roots: string[] = [];
	for (const candidate of options.defaultRoots ?? defaultSessionRoots()) {
		const stats = await stat(candidate).catch(() => null);
		if (stats?.isDirectory() === true) roots.push(candidate);
	}
	return roots;
}

async function collectSessionFiles(root: string, depth = 0): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			if (depth < MAX_DEPTH) files.push(...(await collectSessionFiles(path, depth + 1)));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
	}
	return files;
}

interface SessionScan {
	readonly cwd: string;
	/** Explicit session name, when the file carries one. */
	readonly name: string | null;
	/** First user message, already trimmed to the title budget. */
	readonly firstUser: string | null;
	/** Model recorded at the start of the session, when the file names one. */
	readonly model: string | null;
}

async function scanSession(path: string, maxScanBytes: number): Promise<SessionScan> {
	let cwd = "";
	let name: string | null = null;
	let firstUser: string | null = null;
	let model: string | null = null;
	let headerSeen = false;

	/** Read one record line; returns true once every field the index needs is known. */
	const inspect = (line: string): boolean => {
		if (line.length === 0) return false;

		if (!headerSeen) {
			headerSeen = true;
			const header = parseRecord(line);
			if (header?.type === "session") {
				if (typeof header.cwd === "string") cwd = header.cwd;
				return false;
			}
		}

		if (name === null && line.includes(NAME_HINT)) {
			const record = parseRecord(line);
			if (record?.type === "session_info" && typeof record.name === "string") {
				const trimmed = record.name.trim();
				if (trimmed.length > 0) name = trimmed;
			}
			return false;
		}

		if (model === null && line.includes(MODEL_HINT)) {
			const record = parseRecord(line);
			if (record?.type === "model_change" && typeof record.modelId === "string") model = record.modelId;
			return false;
		}

		if (firstUser === null && line.includes(USER_HINT)) {
			const record = parseRecord(line);
			if (record?.type === "message") {
				const message = record.message as { role?: unknown; content?: unknown } | undefined;
				if (message?.role === "user") {
					const text = messageText(message.content);
					if (text.length > 0) firstUser = text.slice(0, TITLE_LIMIT);
				}
			}
		}

		return name !== null && firstUser !== null;
	};

	const stream = createReadStream(path);
	let buffer = "";
	let inspected = 0;
	try {
		for await (const chunk of stream) {
			const room = Math.max(0, maxScanBytes - inspected);
			const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
			inspected += slice.length;
			buffer += slice.toString("utf8");

			// Once the first user message is known, only the rare record types still matter. Skip a
			// whole chunk that cannot contain one instead of splitting every transcript line, keeping
			// the trailing partial line so a record cut by the chunk boundary is still seen.
			if (firstUser !== null && !buffer.includes(NAME_HINT) && (model !== null || !buffer.includes(MODEL_HINT))) {
				const boundary = buffer.lastIndexOf("\n");
				if (boundary >= 0) buffer = buffer.slice(boundary + 1);
				if (inspected >= maxScanBytes) break;
				continue;
			}

			let start = 0;
			let index = buffer.indexOf("\n");
			let done = false;
			while (index >= 0) {
				done = inspect(buffer.slice(start, index).replace(/\r$/, ""));
				start = index + 1;
				if (done) break;
				index = buffer.indexOf("\n", start);
			}
			if (done) break;
			buffer = buffer.slice(start);
			if (inspected >= maxScanBytes) break;
		}
		if (buffer.length > 0) inspect(buffer.replace(/\r$/, ""));
	} finally {
		stream.destroy();
	}

	return { cwd, name, firstUser, model };
}

function parseRecord(line: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(line);
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** User content is either a string or a list of blocks; only text blocks become a title. */
function messageText(content: unknown): string {
	if (typeof content === "string") return normalise(content);
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
	}
	return normalise(parts.join(" "));
}

function normalise(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
