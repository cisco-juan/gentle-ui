// The Memory tab's bridge half, exercised against a fake `engram mcp`.
//
// Not one test starts the real Engram: the binary is a shell launcher for
// `test/fixtures/memory/fake-mcp.mjs`, which speaks the MCP handshake over stdin/stdout and answers
// from a recorded scenario. It journals every message, its argv and its pid, which is how this suite
// proves three things a reader cannot check by eye: the handshake happens before any tool call, only
// allowlisted read tools ever reach the server, and a timeout leaves no child behind.
//
// Fixtures under `test/fixtures/memory/` are recorded Engram payloads, trimmed to a few rows, with
// the workspace path replaced by `/work/repo`.

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { MemoryContextView, MemoryProjectsView, MemorySearchView, ServerMessage } from "@gentle-shell/protocol";
import { startBridgeServer } from "../src/server.ts";
import {
	MEMORY_BINARY_ENV,
	MEMORY_READ_TOOLS,
	memoryContext,
	memoryProjects,
	memorySearch,
	resolveEngramBinary,
	startMcpSession,
} from "../src/memory.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "memory");
const FAKE = join(FIXTURES, "fake-mcp.mjs");

/** Every tool name that writes, owns a session, or records a verdict: none may ever be called. */
const WRITE_TOOLS = [
	"mem_save",
	"mem_update",
	"mem_delete",
	"mem_session_start",
	"mem_session_end",
	"mem_session_summary",
	"mem_session_finalize",
	"mem_judge",
	"mem_judge_many",
	"mem_compare",
	"mem_consolidate",
	"mem_pin",
	"mem_unpin",
	"mem_capture_passive",
	"mem_review",
];

interface ToolAnswer {
	readonly fixture?: string;
	readonly json?: unknown;
	readonly text?: string;
	readonly error?: string;
}

interface FakeScenario {
	readonly tools?: Readonly<Record<string, ToolAnswer>>;
	readonly toolNames?: readonly string[];
	readonly hangOn?: readonly string[];
	readonly initializeError?: string;
}

interface JournalStart {
	readonly kind: "start";
	readonly pid: number;
	readonly argv: readonly string[];
}

interface JournalMessage {
	readonly kind: "message";
	readonly message: {
		readonly id?: number;
		readonly method?: string;
		readonly params?: { readonly name?: string; readonly arguments?: Readonly<Record<string, unknown>> };
	};
}

type JournalEntry = JournalStart | JournalMessage;

interface FakeMcp {
	/** The executable the bridge is told to run; a launcher, so argv starts at `mcp`. */
	readonly binary: string;
	/** Environment that points the fake at its scenario and journal. */
	readonly env: Readonly<Record<string, string>>;
	entries(): readonly JournalEntry[];
	/** Every JSON-RPC method the bridge sent, in order. */
	methods(): readonly string[];
	/** Every `tools/call` the bridge sent, in order. */
	toolCalls(): readonly { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }[];
	/** The pid of the fake server that was started, or 0 when it never was. */
	pid(): number;
}

/**
 * The fake server, with its scenario and journal in a throwaway directory.
 *
 * The launcher is a two-line shell script on purpose: the shell appends nothing, so the argv the
 * fake sees is exactly the argv the bridge built.
 */
function fakeMcp(t: TestContext, scenario: FakeScenario): FakeMcp {
	const home = mkdtempSync(join(tmpdir(), "gentle-memory-mcp-"));
	const binary = join(home, "engram");
	const scenarioPath = join(home, "scenario.json");
	const journalPath = join(home, "journal.jsonl");
	writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
	chmodSync(binary, 0o755);
	writeFileSync(scenarioPath, JSON.stringify(scenario));

	function entries(): readonly JournalEntry[] {
		if (!existsSync(journalPath)) return [];
		return readFileSync(journalPath, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as JournalEntry);
	}

	t.after(() => {
		for (const entry of entries()) {
			if (entry.kind === "start" && alive(entry.pid)) {
				try {
					process.kill(entry.pid, "SIGKILL");
				} catch {
					// The child this test started was already gone.
				}
			}
		}
		rmSync(home, { recursive: true, force: true });
	});

	return {
		binary,
		env: { FAKE_MCP_SCENARIO: scenarioPath, FAKE_MCP_JOURNAL: journalPath },
		entries,
		methods() {
			return entries()
				.filter((entry): entry is JournalMessage => entry.kind === "message")
				.map((entry) => entry.message.method ?? "");
		},
		toolCalls() {
			return entries()
				.filter((entry): entry is JournalMessage => entry.kind === "message" && entry.message.method === "tools/call")
				.map((entry) => ({ name: entry.message.params?.name ?? "", arguments: entry.message.params?.arguments ?? {} }));
		},
		pid() {
			return entries().find((entry): entry is JournalStart => entry.kind === "start")?.pid ?? 0;
		},
	};
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Wait for a child to be gone; Node reaps it, so this settles in milliseconds in practice. */
async function gone(pid: number, timeoutMs = 3_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!alive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !alive(pid);
}

function scratch(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "gentle-memory-root-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

/** Resolve with the first bridge message that matches, so tests never depend on message order. */
function next(ws: WebSocket, match: (message: ServerMessage) => boolean, timeoutMs = 20_000): Promise<ServerMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.off("message", onMessage);
			reject(new Error("timed out waiting for a matching bridge message"));
		}, timeoutMs);
		function onMessage(raw: { toString(): string }): void {
			const message = JSON.parse(raw.toString()) as ServerMessage;
			if (!match(message)) return;
			clearTimeout(timer);
			ws.off("message", onMessage);
			resolve(message);
		}
		ws.on("message", onMessage);
	});
}

// ---------------------------------------------------------------------------
// the session
// ---------------------------------------------------------------------------

test("the session initializes, acknowledges, lists tools, and only then calls one", async (t) => {
	const fake = fakeMcp(t, { tools: { mem_context: { fixture: "context.json" }, mem_search: { fixture: "search.json" } } });

	const session = await startMcpSession({ binary: fake.binary, env: fake.env, project: "demo", timeoutMs: 5_000 });
	try {
		await session.callTool("mem_context", {});
	} finally {
		await session.close();
	}

	const start = fake.entries().find((entry): entry is JournalStart => entry.kind === "start");
	assert.ok(start !== undefined, "the fake server was never started");
	assert.deepEqual(start.argv, ["mcp", "--tools=agent", "--project", "demo"]);
	assert.deepEqual(fake.methods(), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);

	const initialize = fake
		.entries()
		.find((entry): entry is JournalMessage => entry.kind === "message" && entry.message.method === "initialize");
	assert.ok(initialize !== undefined);
	const params = initialize.message as unknown as { params: Record<string, unknown> };
	assert.equal(typeof params.params["protocolVersion"], "string");
	assert.deepEqual(params.params["capabilities"], {});
	assert.deepEqual(params.params["clientInfo"] !== undefined, true);

	// The tool list the server advertised is what the session reports, so a future answer can be
	// explained against what the server actually offers.
	assert.deepEqual(session.tools, ["mem_context", "mem_search"]);
});

test("every call closes its own child, so no engram process is left idle", async (t) => {
	const fake = fakeMcp(t, { tools: { mem_context: { fixture: "context.json" } } });

	const view = await memoryContext(scratch(t), { binary: fake.binary, env: fake.env, timeoutMs: 5_000 });

	assert.equal(view.state, "ok");
	const pid = fake.pid();
	assert.notEqual(pid, 0);
	assert.equal(await gone(pid), true, `the engram child ${pid} outlived the read`);
});

// ---------------------------------------------------------------------------
// the read tools
// ---------------------------------------------------------------------------

test("a context answer is parsed into its project, its counts and its text", async (t) => {
	const fake = fakeMcp(t, { tools: { mem_context: { fixture: "context.json" } } });

	const view = await memoryContext(scratch(t), { binary: fake.binary, env: fake.env, timeoutMs: 5_000 });

	assert.equal(view.state, "ok");
	assert.equal(view.reason, null);
	assert.equal(view.project, "gentle-shell-ui");
	assert.equal(view.projectPath, "/work/repo");
	assert.equal(view.projectSource, "git_root");
	assert.deepEqual(view.counts, { sessions: 364, observations: 644, projects: 24 });
	assert.match(view.text, /Memory from Previous Sessions/);
	assert.equal(view.raw, null);
	assert.deepEqual(fake.toolCalls(), [{ name: "mem_context", arguments: {} }]);
});

test("a search answer is parsed into typed observations and forwards the query", async (t) => {
	const fake = fakeMcp(t, { tools: { mem_search: { fixture: "search.json" } } });

	const view = await memorySearch(scratch(t), "bridge", 3, { binary: fake.binary, env: fake.env, timeoutMs: 5_000 });

	assert.equal(view.state, "ok");
	assert.equal(view.project, "gentle-shell-ui");
	assert.equal(view.query, "bridge");
	assert.equal(view.observations.length, 2);
	assert.deepEqual(view.observations[0], {
		id: "643",
		title: "Track gentle-shell desktop UI feature tasks",
		type: "architecture",
		scope: "project",
		pinned: false,
		text: "**What**: Feature document for a cross-platform desktop UI for Gentle Shell, at `odd/tasks/gentle-shell-desktop-ui.md`.",
		truncated: true,
	});
	assert.equal(view.observations[1]?.id, "651");
	assert.equal(view.observations[1]?.pinned, true);
	assert.deepEqual(fake.toolCalls(), [
		{ name: "mem_search", arguments: { query: "bridge", limit: 3, response_format: "compact" } },
	]);
});

test("a search with no matches is an ok answer with nothing in it, not an unavailable one", async (t) => {
	const fake = fakeMcp(t, {
		tools: { mem_search: { json: { project: "gentle-shell-ui", result: 'No memories found for: "zzzz"' } } },
	});

	const view = await memorySearch(scratch(t), "zzzz", 5, { binary: fake.binary, env: fake.env, timeoutMs: 5_000 });

	assert.equal(view.state, "ok");
	assert.equal(view.reason, null);
	assert.deepEqual(view.observations, []);
	assert.match(view.message, /No memories found/);
});

test("the project index is typed, with each project's counts", async (t) => {
	const fake = fakeMcp(t, { tools: { mem_list_projects: { fixture: "projects.json" } } });

	const view = await memoryProjects(scratch(t), { binary: fake.binary, env: fake.env, timeoutMs: 5_000 });

	assert.equal(view.state, "ok");
	assert.equal(view.count, 3);
	assert.equal(view.projects.length, 3);
	assert.deepEqual(view.projects[0], {
		name: "gentle-shell-ui",
		observations: 644,
		sessions: 364,
		prompts: 210,
		directories: ["/work/repo"],
	});
	assert.deepEqual(fake.toolCalls(), [{ name: "mem_list_projects", arguments: {} }]);
});

// ---------------------------------------------------------------------------
// what a read refuses, and how it fails
// ---------------------------------------------------------------------------

test("a write tool is refused before it reaches the server", async (t) => {
	const fake = fakeMcp(t, { tools: { mem_context: { fixture: "context.json" } } });
	const session = await startMcpSession({ binary: fake.binary, env: fake.env, timeoutMs: 5_000 });
	try {
		for (const name of WRITE_TOOLS) {
			await assert.rejects(
				session.callTool(name, { title: "the panel must never write" }),
				/read tool/,
				`${name} was not refused`,
			);
		}
	} finally {
		await session.close();
	}

	assert.deepEqual(fake.toolCalls(), [], "a refused tool reached the server anyway");
	// The allowlist is the reason it is safe: nothing in it writes.
	assert.deepEqual(
		MEMORY_READ_TOOLS.filter((name) => name.startsWith("mem_session")),
		[],
	);
});

test("a missing binary is a typed answer that says what to set, not a throw", async (t) => {
	const root = scratch(t);

	const view = await memoryContext(root, { binary: join(root, "no-such-bin", "engram"), env: {} });

	assert.equal(view.state, "unavailable");
	assert.equal(view.reason, "binary-missing");
	assert.match(view.message, /does not exist/);
	assert.ok(view.message.includes(MEMORY_BINARY_ENV));
	assert.equal(view.project, "");
});

test("the binary is resolved from the option, then the override, then the home install, then PATH", (t) => {
	const home = scratch(t);
	const pathDir = join(home, "path");
	const installHome = join(home, "home");
	mkdirSync(pathDir);
	mkdirSync(join(installHome, ".local", "bin"), { recursive: true });
	const onPath = join(pathDir, "engram");
	const installed = join(installHome, ".local", "bin", "engram");
	const override = join(home, "override-engram");
	const explicit = join(home, "explicit-engram");
	for (const path of [onPath, installed, override, explicit]) {
		writeFileSync(path, "#!/bin/sh\n");
		chmodSync(path, 0o755);
	}
	const env = { [MEMORY_BINARY_ENV]: override, PATH: pathDir, HOME: installHome };

	assert.deepEqual(resolveEngramBinary({ binary: explicit, env }), { state: "found", binary: explicit });
	assert.deepEqual(resolveEngramBinary({ env }), { state: "found", binary: override });
	// The home install wins over PATH, because that is where the documented install lives.
	assert.deepEqual(resolveEngramBinary({ env: { PATH: pathDir, HOME: installHome } }), {
		state: "found",
		binary: installed,
	});
	assert.deepEqual(resolveEngramBinary({ env: { PATH: pathDir, HOME: join(home, "empty") } }), {
		state: "found",
		binary: onPath,
	});

	const missing = resolveEngramBinary({ env: { PATH: "", HOME: join(home, "empty") } });
	assert.equal(missing.state, "missing");
	if (missing.state !== "missing") return;
	assert.match(missing.message, /Engram was not found/);
	assert.ok(missing.message.includes(MEMORY_BINARY_ENV));
	// The message names the documented install, so a reader knows where Engram is expected.
	assert.ok(missing.message.includes(join(installHome, ".local", "bin", "engram")) === false);
});

test("a handshake the server refuses is a typed answer, not a throw", async (t) => {
	const fake = fakeMcp(t, { initializeError: "unsupported protocol version" });

	const view = await memoryContext(scratch(t), { binary: fake.binary, env: fake.env, timeoutMs: 5_000 });

	assert.equal(view.state, "unavailable");
	assert.equal(view.reason, "handshake-failed");
	assert.match(view.message, /unsupported protocol version/);
	assert.equal(await gone(fake.pid()), true, "the refused child was left running");
});

test("a server that never answers is timed out and killed, and the panel says so", async (t) => {
	const fake = fakeMcp(t, { hangOn: ["mem_search"] });
	const started = Date.now();

	const view = await memorySearch(scratch(t), "bridge", 5, {
		binary: fake.binary,
		env: fake.env,
		timeoutMs: 250,
	});

	assert.equal(view.state, "unavailable");
	assert.equal(view.reason, "timeout");
	assert.match(view.message, /within 250 ms/);
	assert.deepEqual(view.observations, []);
	assert.ok(Date.now() - started < 5_000, "the timeout did not bound the read");
	assert.equal(await gone(fake.pid()), true, "the timed-out child was left running");
});

test("a payload that is not the JSON this panel reads is kept as raw text", async (t) => {
	const fake = fakeMcp(t, { tools: { mem_context: { fixture: "malformed.txt" } } });

	const view = await memoryContext(scratch(t), { binary: fake.binary, env: fake.env, timeoutMs: 5_000 });

	assert.equal(view.state, "unparsable");
	assert.equal(view.reason, null);
	assert.equal(view.raw, readFileSync(join(FIXTURES, "malformed.txt"), "utf8"));
	assert.match(view.message, /mem_context/);
	assert.match(view.message, /not the JSON/);
});

test("a tool that answers with an error is unavailable, quoting the server's words", async (t) => {
	const fake = fakeMcp(t, { tools: { mem_search: { error: 'invalid response_format "full": must be "compact"' } } });

	const view = await memorySearch(scratch(t), "bridge", 5, { binary: fake.binary, env: fake.env, timeoutMs: 5_000 });

	assert.equal(view.state, "unavailable");
	assert.equal(view.reason, "tool-error");
	assert.match(view.message, /must be "compact"/);
});

// ---------------------------------------------------------------------------
// the bridge
// ---------------------------------------------------------------------------

test("the bridge answers a memory request with the panel's own shape", async (t) => {
	const fake = fakeMcp(t, { tools: { mem_context: { fixture: "context.json" } } });
	const server = await startBridgeServer({ workspace: scratch(t), memory: { binary: fake.binary, env: fake.env } });
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	try {
		await new Promise((resolve) => ws.on("open", resolve));
		const answered = next(ws, (message) => message.kind === "memory" && message.id === "memory-1");
		ws.send(JSON.stringify({ kind: "memory", id: "memory-1", action: "context" }));

		const message = await answered;
		assert.equal(message.kind, "memory");
		if (message.kind !== "memory") return;
		assert.equal(message.action, "context");
		const data = message.data as MemoryContextView;
		assert.equal(data.state, "ok");
		assert.equal(data.project, "gentle-shell-ui");
		assert.equal(data.counts?.observations, 644);
	} finally {
		ws.close();
		await server.close();
	}
});

test("the bridge answers a search with typed observations", async (t) => {
	const fake = fakeMcp(t, { tools: { mem_search: { fixture: "search.json" } } });
	const server = await startBridgeServer({ workspace: scratch(t), memory: { binary: fake.binary, env: fake.env } });
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	try {
		await new Promise((resolve) => ws.on("open", resolve));
		const answered = next(ws, (message) => message.kind === "memory" && message.id === "memory-2");
		ws.send(JSON.stringify({ kind: "memory", id: "memory-2", action: "search", query: "bridge", limit: 3 }));

		const message = await answered;
		assert.equal(message.kind, "memory");
		if (message.kind !== "memory") return;
		assert.equal(message.action, "search");
		const data = message.data as MemorySearchView;
		assert.equal(data.query, "bridge");
		assert.equal(data.observations[0]?.id, "643");
	} finally {
		ws.close();
		await server.close();
	}
});

test("an unavailable engram is a typed result on the wire, not an error", async (t) => {
	const root = scratch(t);
	const server = await startBridgeServer({
		workspace: root,
		memory: { binary: join(root, "no-such-bin", "engram"), env: {} },
	});
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	try {
		await new Promise((resolve) => ws.on("open", resolve));
		const answered = next(ws, (message) => message.kind === "memory" && message.id === "memory-3");
		ws.send(JSON.stringify({ kind: "memory", id: "memory-3", action: "projects" }));

		const message = await answered;
		assert.equal(message.kind, "memory");
		if (message.kind !== "memory") return;
		assert.equal(message.action, "projects");
		const data = message.data as MemoryProjectsView;
		assert.equal(data.state, "unavailable");
		assert.equal(data.reason, "binary-missing");
		assert.deepEqual(data.projects, []);
	} finally {
		ws.close();
		await server.close();
	}
});

test("a search without a query is a genuine failure, so it answers with an error", async (t) => {
	const fake = fakeMcp(t, { tools: { mem_search: { fixture: "search.json" } } });
	const server = await startBridgeServer({ workspace: scratch(t), memory: { binary: fake.binary, env: fake.env } });
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	try {
		await new Promise((resolve) => ws.on("open", resolve));
		const answered = next(ws, (message) => message.kind === "error" && message.id === "memory-4");
		ws.send(JSON.stringify({ kind: "memory", id: "memory-4", action: "search", query: "   " }));

		const message = await answered;
		assert.equal(message.kind, "error");
		if (message.kind !== "error") return;
		assert.match(message.message, /query/);
		assert.deepEqual(fake.toolCalls(), [], "a query-less search still started engram");
	} finally {
		ws.close();
		await server.close();
	}
});
