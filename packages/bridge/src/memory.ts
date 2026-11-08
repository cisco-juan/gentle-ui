import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	MemoryContextView,
	MemoryCounts,
	MemoryFailureReason,
	MemoryObservation,
	MemoryProjectEntry,
	MemoryProjectsView,
	MemorySearchView,
} from "@gentle-shell/protocol";

/**
 * Engram's memory, read through `engram mcp` over stdio.
 *
 * Engram has no one-shot read command, so every read here is a short-lived MCP session: spawn
 * `engram mcp --tools=agent`, initialize, acknowledge, ask one read tool, and kill the child. Four
 * rules are load-bearing:
 *
 * - The panel is read-only by construction. `MEMORY_READ_TOOLS` is the entire set of tools this
 *   module may call, and `callTool` refuses anything else before a byte reaches the server, so no
 *   renderer input can turn a search into a save.
 * - Framing is strict JSONL: records split on LF only, because a generic line reader also splits on
 *   U+2028/U+2029, which are legal inside a JSON string.
 * - Every request is bounded. A timeout kills the child instead of leaving an `engram` process idle
 *   behind a closed tab, and so does every other failure path.
 * - A payload is either the JSON this panel reads or it is `unparsable` with its text kept for
 *   display. Nothing is guessed from a shape that merely looks close.
 */

/** The override for the binary, so a dev build is an explicit choice rather than a PATH accident. */
export const MEMORY_BINARY_ENV = "GENTLE_SHELL_ENGRAM_BINARY";
/** The MCP revision this client speaks; Engram 3.6.0 answers it verbatim. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";
/** A local sqlite read plus a process spawn: seconds, not minutes. */
export const DEFAULT_MEMORY_TIMEOUT_MS = 15_000;
/** How long a child gets to leave after SIGTERM before it is killed outright. */
const CLOSE_GRACE_MS = 1_000;
const BINARY_NAME = process.platform === "win32" ? "engram.exe" : "engram";

/**
 * Every tool this module may call. It is a literal list rather than a name pattern: a tool added to
 * Engram tomorrow is refused until someone reads it and decides, and `mem_save`, `mem_update`,
 * `mem_delete`, the `mem_session_*` family, `mem_judge`, `mem_consolidate` and `mem_pin` can never
 * be reached through a typo or a forged name.
 */
export const MEMORY_READ_TOOLS = ["mem_context", "mem_list_projects", "mem_search"] as const;

export function isMemoryReadTool(name: string): boolean {
	return (MEMORY_READ_TOOLS as readonly string[]).includes(name);
}

export interface MemoryOptions {
	/** Absolute path to `engram`. Tests point this at a fake server. */
	readonly binary?: string;
	/** Pin the project instead of letting Engram derive it from the workspace. */
	readonly project?: string;
	readonly timeoutMs?: number;
	readonly env?: Readonly<Record<string, string>>;
}

export type EngramBinaryAnswer =
	| { readonly state: "found"; readonly binary: string }
	| { readonly state: "missing"; readonly message: string };

/**
 * Where `engram` lives.
 *
 * The order is an explicit option, then the documented override, then the install the release script
 * uses, then PATH resolved to an absolute path. A path that was named explicitly and does not exist
 * is reported as missing instead of falling through: silently reading a different binary than the one
 * configured would make the panel lie about which memory it is showing.
 */
export function resolveEngramBinary(options: MemoryOptions = {}): EngramBinaryAnswer {
	const env = options.env ?? process.env;
	const explicit = options.binary ?? env[MEMORY_BINARY_ENV];
	if (explicit !== undefined && explicit.trim().length > 0) {
		const path = resolve(explicit.trim());
		if (isFile(path)) return { state: "found", binary: path };
		return {
			state: "missing",
			message: `the Engram binary at ${path} does not exist; set ${MEMORY_BINARY_ENV} to the path of engram.`,
		};
	}

	const installed = join(env["HOME"] ?? homedir(), ".local", "bin", BINARY_NAME);
	if (isFile(installed)) return { state: "found", binary: installed };

	const onPath = binaryOnPath(env["PATH"] ?? env["Path"] ?? "");
	if (onPath !== null) return { state: "found", binary: onPath };

	return {
		state: "missing",
		message: `Engram was not found: install it at ${installed} or set ${MEMORY_BINARY_ENV} to its absolute path.`,
	};
}

/** A failure the panel can name, so `unavailable` always carries a reason and never an empty list. */
export class MemoryMcpError extends Error {
	readonly reason: MemoryFailureReason;

	constructor(reason: MemoryFailureReason, message: string) {
		super(message);
		this.name = "MemoryMcpError";
		this.reason = reason;
	}
}

export interface McpSessionOptions {
	readonly binary: string;
	/** Passed as `--project`, so Engram's own project resolution is what decides. */
	readonly project?: string;
	/** Working directory of the child; Engram derives the project from it when none is pinned. */
	readonly cwd?: string;
	readonly timeoutMs?: number;
	readonly env?: Readonly<Record<string, string>>;
}

export interface McpSession {
	readonly binary: string;
	/** The tool names the server advertised, in the order it advertised them. */
	readonly tools: readonly string[];
	/** One read tool call; resolves with the text payload of its result. */
	callTool(name: string, args?: Readonly<Record<string, unknown>>): Promise<string>;
	close(): Promise<void>;
}

/** Start one session: spawn, initialize, acknowledge, list tools. The child is killed on failure. */
export async function startMcpSession(options: McpSessionOptions): Promise<McpSession> {
	const session = new McpStdioSession(options);
	try {
		await session.start();
	} catch (error) {
		await session.close();
		throw error;
	}
	return session;
}

interface PendingRequest {
	readonly method: string;
	readonly reason: MemoryFailureReason;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
}

class McpStdioSession implements McpSession {
	#child: ChildProcess | null = null;
	#buffer = "";
	#counter = 0;
	#pending = new Map<number, PendingRequest>();
	#stderr: string[] = [];
	#tools: readonly string[] = [];
	#exited = false;
	#closed = false;
	readonly #options: McpSessionOptions;

	constructor(options: McpSessionOptions) {
		this.#options = options;
	}

	get binary(): string {
		return this.#options.binary;
	}

	get tools(): readonly string[] {
		return this.#tools;
	}

	async start(): Promise<void> {
		const argv = ["mcp", "--tools=agent"];
		if (this.#options.project !== undefined) argv.push("--project", this.#options.project);

		const child = spawn(this.#options.binary, argv, {
			...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
			env: { ...process.env, ...(this.#options.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child = child;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		// A write that races a child's death is a closed session, not a panel failure to report.
		child.stdin?.on("error", () => undefined);
		child.stdout?.on("data", (chunk: string) => this.#consume(chunk));
		child.stderr?.on("data", (chunk: string) => this.#consumeStderr(chunk));
		child.on("error", (error) => {
			// A spawn failure emits `error` and no `exit` on some platforms, so the child is marked
			// gone here as well; otherwise close() would wait for an exit that never comes.
			this.#exited = true;
			this.#fail(`engram could not be started (${error.message})`);
		});
		child.on("exit", (code, signal) => this.#onExit(code, signal));

		const initialized = asRecord(await this.#request("initialize", initializeParams(), "handshake-failed"));
		if (initialized === null || text(initialized["protocolVersion"]) === null) {
			throw new MemoryMcpError("handshake-failed", "engram answered initialize without a protocol version");
		}
		this.#notify("notifications/initialized");

		const listed = asRecord(await this.#request("tools/list", {}, "handshake-failed"));
		const tools = listed === null ? null : listed["tools"];
		this.#tools = Array.isArray(tools)
			? tools
					.map((entry) => asRecord(entry)?.["name"])
					.filter((name): name is string => typeof name === "string" && name.length > 0)
			: [];
	}

	async callTool(name: string, args: Readonly<Record<string, unknown>> = {}): Promise<string> {
		if (!isMemoryReadTool(name)) {
			throw new MemoryMcpError("tool-refused", `"${name}" is not a read tool, so the Memory panel will not call it`);
		}

		const result = asRecord(await this.#request("tools/call", { name, arguments: args }, "tool-error"));
		const content = result === null ? null : result["content"];
		const block = Array.isArray(content)
			? content.map(asRecord).find((entry) => entry !== null && entry["type"] === "text")
			: null;
		const payload = block === null || block === undefined ? null : payloadText(block["text"]);
		if (payload === null) {
			throw new MemoryMcpError("tool-error", `engram answered ${name} without a text payload`);
		}
		if (result?.["isError"] === true) {
			throw new MemoryMcpError("tool-error", `engram refused ${name}: ${firstLine(payload) ?? "no reason given"}`);
		}
		return payload;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#fail("the memory session was closed");

		const child = this.#child;
		if (!child || this.#exited) return;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.stdin?.end();
		child.kill("SIGTERM");
		await Promise.race([exited, delay(CLOSE_GRACE_MS)]);
		if (!this.#exited) child.kill("SIGKILL");
		await Promise.race([exited, delay(CLOSE_GRACE_MS)]);
	}

	#request(
		method: string,
		params: Readonly<Record<string, unknown>>,
		reason: MemoryFailureReason,
	): Promise<unknown> {
		const child = this.#child;
		if (!child || this.#exited || this.#closed) {
			return Promise.reject(new MemoryMcpError(reason, "the Engram session is not running"));
		}

		const id = ++this.#counter;
		const timeoutMs = this.#options.timeoutMs ?? DEFAULT_MEMORY_TIMEOUT_MS;

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				this.#kill();
				reject(
					new MemoryMcpError(
						"timeout",
						`engram did not answer "${method}" within ${timeoutMs} ms, so it was stopped`,
					),
				);
			}, timeoutMs);

			this.#pending.set(id, { method, reason, resolve, reject, timer });
			this.#write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`).catch((error: unknown) => {
				const pending = this.#pending.get(id);
				this.#pending.delete(id);
				if (pending) clearTimeout(pending.timer);
				this.#kill();
				reject(new MemoryMcpError(reason, `engram could not be written to: ${errorMessage(error)}`));
			});
		});
	}

	/** A notification has no id and no answer, so it is only written. */
	#notify(method: string): void {
		this.#write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`).catch((error: unknown) => {
			this.#fail(`engram could not be written to: ${errorMessage(error)}`);
			this.#kill();
		});
	}

	async #write(line: string): Promise<void> {
		const stdin = this.#child?.stdin;
		if (!stdin || stdin.destroyed) throw new Error("the Engram session stdin is closed");

		await new Promise<void>((resolve, reject) => {
			const drained = stdin.write(line, (error) => {
				if (error) reject(error);
			});
			if (drained) resolve();
			else stdin.once("drain", () => resolve());
		});
	}

	#consume(chunk: string): void {
		this.#buffer += chunk;
		let index = this.#buffer.indexOf("\n");
		while (index >= 0) {
			const raw = this.#buffer.slice(0, index);
			this.#buffer = this.#buffer.slice(index + 1);
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (line.trim().length > 0) this.#handleLine(line);
			index = this.#buffer.indexOf("\n");
		}
	}

	#handleLine(line: string): void {
		let record: Record<string, unknown> | null;
		try {
			record = asRecord(JSON.parse(line) as unknown);
		} catch {
			record = null;
		}
		if (record === null) {
			// A server that writes something other than JSON-RPC cannot be reasoned with, and guessing
			// which request it was answering would hide the breakage.
			this.#fail(`engram wrote a line that is not JSON-RPC: ${line.slice(0, 200)}`);
			this.#kill();
			return;
		}
		this.#settle(record);
	}

	#settle(record: Record<string, unknown>): void {
		const raw = record["id"];
		const id = typeof raw === "number" ? raw : null;
		const pending = id === null ? undefined : this.#pending.get(id);
		// No pending request means a server notification, or an answer to something already abandoned.
		if (pending === undefined || id === null) return;

		this.#pending.delete(id);
		clearTimeout(pending.timer);

		const error = asRecord(record["error"]);
		if (error !== null) {
			pending.reject(
				new MemoryMcpError(
					pending.reason,
					`engram answered ${pending.method} with an error: ${text(error["message"]) ?? "no message"}`,
				),
			);
			return;
		}
		pending.resolve(record["result"]);
	}

	#consumeStderr(chunk: string): void {
		for (const line of chunk.split("\n")) {
			if (line.trim().length === 0) continue;
			this.#stderr.push(line);
			if (this.#stderr.length > 20) this.#stderr.shift();
		}
	}

	#onExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.#exited = true;
		const detail = signal === null ? `code ${code ?? "null"}` : `signal ${signal}`;
		const tail = lastLine(this.#stderr);
		this.#fail(`engram exited (${detail})${tail === null ? "" : `: ${tail}`}`);
	}

	/** Reject everything still waiting, so a dead child never leaves a promise hanging. */
	#fail(detail: string): void {
		for (const [, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(new MemoryMcpError(pending.reason, `${pending.method} failed: ${detail}`));
		}
		this.#pending.clear();
	}

	#kill(): void {
		const child = this.#child;
		if (!child || this.#exited) return;
		child.kill("SIGKILL");
	}
}

// ---------------------------------------------------------------------------
// the reads
// ---------------------------------------------------------------------------

/** A context answer: the project Engram derived, its counts, and the history text it printed. */
export async function memoryContext(root: string, options: MemoryOptions = {}): Promise<MemoryContextView> {
	const read = await readTool(root, options, (session) => session.callTool("mem_context", {}));
	if ("failure" in read) return unavailableContext(read.failure);
	return parseContext(read.text);
}

/**
 * A search answer: the typed hits, or the server's own "no memories found" text.
 *
 * `response_format: "compact"` is what makes Engram return structured rows (id, type, scope, preview)
 * instead of only the markdown list, so the panel never has to scrape titles out of prose.
 */
export async function memorySearch(
	root: string,
	query: string,
	limit = 20,
	options: MemoryOptions = {},
): Promise<MemorySearchView> {
	const asked = query.trim();
	if (asked.length === 0) throw new Error("a memory search needs a query");

	const read = await readTool(root, options, (session) =>
		session.callTool("mem_search", { query: asked, limit, response_format: "compact" }),
	);
	if ("failure" in read) return unavailableSearch(asked, read.failure);
	return parseSearch(read.text, asked);
}

/** Engram's project index: every project it knows, with the counts it reports for each. */
export async function memoryProjects(root: string, options: MemoryOptions = {}): Promise<MemoryProjectsView> {
	const read = await readTool(root, options, (session) => session.callTool("mem_list_projects", {}));
	if ("failure" in read) return unavailableProjects(read.failure);
	return parseProjects(read.text);
}

interface Failure {
	readonly reason: MemoryFailureReason;
	readonly message: string;
}

type ReadOutcome = { readonly text: string } | { readonly failure: Failure };

/**
 * One read in one session.
 *
 * The session is spawned, handshaken, asked exactly one thing, and closed, so a panel that is hidden
 * costs nothing until it is asked again and no `engram mcp` child is left running behind a closed tab.
 */
async function readTool(
	root: string,
	options: MemoryOptions,
	work: (session: McpSession) => Promise<string>,
): Promise<ReadOutcome> {
	const binary = resolveEngramBinary(options);
	if (binary.state === "missing") return { failure: { reason: "binary-missing", message: binary.message } };

	let session: McpSession;
	try {
		session = await startMcpSession({
			binary: binary.binary,
			cwd: root,
			...(options.project === undefined ? {} : { project: options.project }),
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			...(options.env === undefined ? {} : { env: options.env }),
		});
	} catch (error) {
		return { failure: failureOf(error) };
	}

	try {
		return { text: await work(session) };
	} catch (error) {
		return { failure: failureOf(error) };
	} finally {
		await session.close();
	}
}

function failureOf(error: unknown): Failure {
	if (error instanceof MemoryMcpError) return { reason: error.reason, message: error.message };
	return { reason: "tool-error", message: errorMessage(error) };
}

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

function parseContext(payload: string): MemoryContextView {
	const record = asRecord(parseJson(payload));
	if (record === null) {
		return unreadableContext(payload, "engram answered mem_context with text that is not the JSON this panel reads");
	}
	const body = payloadText(record["result"]);
	if (body === null) return unreadableContext(payload, 'engram answered mem_context without the "result" text');

	const counts = parseStats(body);
	return {
		state: "ok",
		reason: null,
		message:
			counts === null
				? "Engram answered with its context, but not its memory stats."
				: `${counts.observations} observations, ${counts.sessions} sessions across ${counts.projects} projects.`,
		project: trimmed(record["project"]),
		projectPath: trimmed(record["project_path"]),
		projectSource: trimmed(record["project_source"]),
		counts,
		text: body,
		raw: null,
	};
}

function parseSearch(payload: string, query: string): MemorySearchView {
	const record = asRecord(parseJson(payload));
	if (record === null) {
		return unreadableSearch(payload, query, "engram answered mem_search with text that is not the JSON this panel reads");
	}
	const body = payloadText(record["result"]);
	if (body === null) return unreadableSearch(payload, query, 'engram answered mem_search without the "result" text');

	const listed = record["results"];
	if (listed !== undefined && !Array.isArray(listed)) {
		return unreadableSearch(payload, query, "engram answered mem_search with a results field that is not a list");
	}

	const observations: MemoryObservation[] = [];
	for (const entry of Array.isArray(listed) ? listed : []) {
		const row = asRecord(entry);
		if (row === null) {
			return unreadableSearch(payload, query, "engram answered mem_search with a result that is not an object");
		}
		observations.push(observationOf(row));
	}

	return {
		state: "ok",
		reason: null,
		message:
			observations.length === 0
				? (firstLine(body) ?? "No memories match this search.")
				: `${observations.length} ${observations.length === 1 ? "memory" : "memories"} match "${query}".`,
		project: trimmed(record["project"]),
		query,
		observations,
		text: body,
		raw: null,
	};
}

function parseProjects(payload: string): MemoryProjectsView {
	const record = asRecord(parseJson(payload));
	if (record === null) {
		return unreadableProjects(
			payload,
			"engram answered mem_list_projects with text that is not the JSON this panel reads",
		);
	}
	const listed = record["projects"];
	if (!Array.isArray(listed)) {
		return unreadableProjects(payload, 'engram answered mem_list_projects without a "projects" list');
	}

	const projects: MemoryProjectEntry[] = [];
	for (const entry of listed) {
		const row = asRecord(entry);
		if (row === null) {
			return unreadableProjects(payload, "engram answered mem_list_projects with a project that is not an object");
		}
		const name = trimmed(row["name"]);
		if (name.length === 0) {
			return unreadableProjects(payload, "engram answered mem_list_projects with a project that has no name");
		}
		projects.push({
			name,
			observations: count(row["observation_count"]),
			sessions: count(row["session_count"]),
			prompts: count(row["prompt_count"]),
			directories: strings(row["directories"]),
		});
	}

	const reported = count(record["count"]);
	return {
		state: "ok",
		reason: null,
		message: `${projects.length} ${projects.length === 1 ? "project" : "projects"} with memory.`,
		// The server's own total wins when it is larger than the list it sent, so a truncated index is
		// not reported as a small one.
		count: Math.max(reported, projects.length),
		projects,
		text: "",
		raw: null,
	};
}

function observationOf(row: Record<string, unknown>): MemoryObservation {
	const id = row["id"];
	return {
		id: typeof id === "number" && Number.isFinite(id) ? String(id) : trimmed(id),
		title: trimmed(row["title"]),
		type: trimmed(row["type"]),
		scope: trimmed(row["scope"]),
		pinned: row["pinned"] === true,
		text: payloadText(row["preview"]) ?? payloadText(row["content"]) ?? "",
		truncated: row["truncated"] === true,
	};
}

/** The stats line Engram ends a context answer with, or null when it printed none. */
function parseStats(text: string): MemoryCounts | null {
	const match = /Memory stats:\s*(\d+)\s+sessions?,\s*(\d+)\s+observations?\s+across\s+projects:\s*([^\n]+)/i.exec(text);
	if (match === null) return null;
	return {
		sessions: count(match[1] === undefined ? undefined : Number.parseInt(match[1], 10)),
		observations: count(match[2] === undefined ? undefined : Number.parseInt(match[2], 10)),
		projects: projectListCount(match[3] ?? ""),
	};
}

/** A comma-separated project list that ends in "+N more" names N projects it did not list. */
function projectListCount(list: string): number {
	let total = 0;
	for (const raw of list.split(",")) {
		const name = raw.trim();
		if (name.length === 0) continue;
		const more = /^\+(\d+)\s+more$/i.exec(name);
		total += more === null ? 1 : count(Number.parseInt(more[1] ?? "", 10));
	}
	return total;
}

function unavailableContext(failure: Failure): MemoryContextView {
	return {
		state: "unavailable",
		reason: failure.reason,
		message: failure.message,
		project: "",
		projectPath: "",
		projectSource: "",
		counts: null,
		text: "",
		raw: null,
	};
}

function unavailableSearch(query: string, failure: Failure): MemorySearchView {
	return {
		state: "unavailable",
		reason: failure.reason,
		message: failure.message,
		project: "",
		query,
		observations: [],
		text: "",
		raw: null,
	};
}

function unavailableProjects(failure: Failure): MemoryProjectsView {
	return {
		state: "unavailable",
		reason: failure.reason,
		message: failure.message,
		count: 0,
		projects: [],
		text: "",
		raw: null,
	};
}

function unreadableContext(raw: string, message: string): MemoryContextView {
	return { ...unavailableContext({ reason: "tool-error", message }), state: "unparsable", reason: null, raw };
}

function unreadableSearch(raw: string, query: string, message: string): MemorySearchView {
	return {
		...unavailableSearch(query, { reason: "tool-error", message }),
		state: "unparsable",
		reason: null,
		raw,
	};
}

function unreadableProjects(raw: string, message: string): MemoryProjectsView {
	return { ...unavailableProjects({ reason: "tool-error", message }), state: "unparsable", reason: null, raw };
}

// ---------------------------------------------------------------------------
// small readers
// ---------------------------------------------------------------------------

function initializeParams(): Record<string, unknown> {
	return {
		protocolVersion: MCP_PROTOCOL_VERSION,
		clientInfo: { name: "gentle-shell", version: "0.1.0" },
		capabilities: {},
	};
}

function parseJson(raw: unknown): unknown {
	if (typeof raw !== "string") return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/** A trimmed string, or "" when the field is absent: the panel never invents a missing value. */
function trimmed(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** A tool payload, kept verbatim because that is what a display has to show when parsing fails. */
function payloadText(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	return value;
}

function text(value: unknown): string | null {
	const found = trimmed(value);
	return found.length === 0 ? null : found;
}

function strings(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.map(trimmed).filter((entry) => entry.length > 0);
}

function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.round(value));
}

function firstLine(value: string): string | null {
	const line = value
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	return line ?? null;
}

function lastLine(lines: readonly string[]): string | null {
	const line = [...lines].reverse().find((entry) => entry.trim().length > 0);
	return line === undefined ? null : line.trim();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function binaryOnPath(path: string): string | null {
	for (const entry of path.split(process.platform === "win32" ? ";" : ":")) {
		if (entry.length === 0) continue;
		const candidate = join(entry, BINARY_NAME);
		if (isFile(candidate)) return candidate;
	}
	return null;
}
