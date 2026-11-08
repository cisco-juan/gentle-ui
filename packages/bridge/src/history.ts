import { readFile, realpath, stat } from "node:fs/promises";
import { sep } from "node:path";
import type { HistoryEntry, HistoryPage, HistoryTool } from "@gentle-shell/protocol";
import { defaultSessionRoots } from "./sessions.ts";

/**
 * Paged transcript, read from the session file the rail already lists.
 *
 * Pi's `get_messages` answers with the tail of a session, so a long thread reopened as three rows. The
 * file has every turn, and the UI reads backwards from its end: the newest page first, then one older
 * page each time the reader reaches the top. Nothing here renders: it turns lines into turns, and a
 * page into the cursor that continues it.
 */

/** Turns in one page when the caller does not say. */
export const DEFAULT_HISTORY_LIMIT = 40;
/** A page larger than this is a caller mistake, not a reading preference. */
const MAX_HISTORY_LIMIT = 200;

export interface HistoryPageOptions {
	/** Cursor a previous page returned: the entry index this page ends at. */
	readonly before?: number;
	readonly limit?: number;
}

export interface HistoryReadOptions extends HistoryPageOptions {
	/** Explicit session root. Defaults to `PI_SESSION_DIR` when set, else Pi's own directories. */
	readonly sessionDir?: string;
}

/**
 * One page of an already-parsed session file, oldest to newest inside the page.
 *
 * Pure on purpose: every rule the transcript obeys (what counts as a turn, where a tool result belongs,
 * which page a cursor names) is decided here, so it can be stated by a test without a file on disk.
 */
export function pageHistory(lines: readonly unknown[], options: HistoryPageOptions = {}): HistoryPage {
	const entries = transcriptOf(lines);
	const limit = pageLimit(options.limit);
	const end = cursorOf(options.before, entries.length);
	const start = Math.max(0, end - limit);
	return { entries: entries.slice(start, end), before: start > 0 ? start : null, total: entries.length };
}

/**
 * Read one page from a session file.
 *
 * The path arrives from the client, so it is resolved with `realpath` and must land on a file inside a
 * session directory the bridge lists; anything else is refused instead of read.
 */
export async function readHistoryPage(sessionPath: string, options: HistoryReadOptions = {}): Promise<HistoryPage> {
	const file = await sessionFile(sessionPath, options.sessionDir);
	const text = await readFile(file, "utf8");
	return pageHistory(text.split("\n"), options);
}

/** Resolve and validate one session path against the roots the index scans. */
async function sessionFile(sessionPath: string, explicitRoot: string | undefined): Promise<string> {
	if (sessionPath.trim().length === 0) throw new Error("a session file is required");

	const file = await realpath(sessionPath).catch(() => null);
	const stats = file === null ? null : await stat(file).catch(() => null);
	if (file === null || stats?.isFile() !== true) {
		throw new Error(`no session file at ${sessionPath}`);
	}

	const roots = await sessionRoots(explicitRoot);
	if (!roots.some((root) => file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) {
		throw new Error(`not a file under the bridge's session directory: ${sessionPath}`);
	}
	return file;
}

/** Real paths of the directories the session index reads, so a symlinked root still matches. */
async function sessionRoots(explicitRoot: string | undefined): Promise<string[]> {
	const configured = explicitRoot ?? process.env.PI_SESSION_DIR;
	const candidates =
		configured !== undefined && configured.trim().length > 0 ? [configured] : defaultSessionRoots();

	const roots: string[] = [];
	for (const candidate of candidates) {
		const resolved = await realpath(candidate).catch(() => null);
		if (resolved !== null) roots.push(resolved);
	}
	return roots;
}

function pageLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_HISTORY_LIMIT;
	return Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.floor(limit)));
}

/** A cursor is an entry index; anything the client cannot have meant means "the newest page". */
function cursorOf(before: number | undefined, total: number): number {
	if (before === undefined || !Number.isFinite(before)) return total;
	return Math.min(total, Math.max(0, Math.floor(before)));
}

/** The conversation turns of a file: tool results folded into their call, empty turns dropped. */
function transcriptOf(lines: readonly unknown[]): HistoryEntry[] {
	const results = toolResultsOf(lines);
	const entries: HistoryEntry[] = [];

	for (const line of lines) {
		const record = recordOf(line);
		if (record?.type !== "message") continue;
		const message = asRecord(record.message);
		if (message === null) continue;
		const role = message.role;
		if (role !== "user" && role !== "assistant") continue;

		const id = typeof record.id === "string" && record.id.length > 0 ? record.id : `entry-${entries.length + 1}`;
		const text = textOf(message.content);
		if (role === "user") {
			if (text.trim().length === 0) continue;
			entries.push({ id, role: "user", text, thinking: null, model: null });
			continue;
		}

		const thinking = thinkingOf(message.content);
		const tools = toolsOf(message.content, results);
		// A turn that says nothing, thought nothing and called nothing is not part of the conversation.
		if (text.trim().length === 0 && thinking === null && tools.length === 0) continue;
		entries.push({
			id,
			role: "assistant",
			text,
			thinking,
			model: typeof message.model === "string" && message.model.length > 0 ? message.model : null,
			tools,
		});
	}
	return entries;
}

interface ToolResult {
	readonly output: string;
	readonly isError: boolean;
}

/** Results by call id, so a tool call can be completed by a line that arrives after it. */
function toolResultsOf(lines: readonly unknown[]): Map<string, ToolResult> {
	const results = new Map<string, ToolResult>();
	for (const line of lines) {
		const record = recordOf(line);
		if (record?.type !== "message") continue;
		const message = asRecord(record.message);
		if (message?.role !== "toolResult") continue;
		const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
		if (callId.length === 0) continue;
		results.set(callId, { output: textOf(message.content), isError: message.isError === true });
	}
	return results;
}

function toolsOf(content: unknown, results: Map<string, ToolResult>): HistoryTool[] {
	if (!Array.isArray(content)) return [];
	const tools: HistoryTool[] = [];
	for (const block of content) {
		const typed = asRecord(block);
		if (typed?.type !== "toolCall") continue;
		const id = typeof typed.id === "string" ? typed.id : "";
		const result = id.length > 0 ? results.get(id) : undefined;
		tools.push({
			id,
			name: typeof typed.name === "string" && typed.name.length > 0 ? typed.name : "tool",
			input: parseArguments(typed.arguments),
			output: result?.output ?? "",
			isError: result?.isError ?? false,
		});
	}
	return tools;
}

/** Pi writes arguments as an object; an older file may hold them as the JSON string it was given. */
function parseArguments(value: unknown): unknown {
	if (typeof value !== "string") return value ?? {};
	const text = value.trim();
	if (text.length === 0) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return value;
	}
}

/** A message body is either a string or a list of blocks; only text blocks are spoken text. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const typed = asRecord(block);
		if (typed?.type === "text" && typeof typed.text === "string") parts.push(typed.text);
	}
	return parts.join("");
}

/** The reasoning behind a turn, or null when the file kept none. */
function thinkingOf(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		const typed = asRecord(block);
		if (typed?.type === "thinking" && typeof typed.thinking === "string") parts.push(typed.thinking);
	}
	const text = parts.join("");
	return text.trim().length > 0 ? text : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * One line of a session file, whether it arrives parsed or still the JSONL text read from disk.
 *
 * A half-written line is what a session looks like while Pi is appending to it, so a line that does not
 * parse is skipped rather than failing the page.
 */
function recordOf(line: unknown): Record<string, unknown> | null {
	if (typeof line !== "string") return asRecord(line);
	const text = line.trim();
	if (text.length === 0) return null;
	try {
		return asRecord(JSON.parse(text));
	} catch {
		return null;
	}
}
