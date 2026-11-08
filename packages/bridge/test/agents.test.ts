// The Agents tab, read from what gentle-pi already writes about its subagents.
//
// The tab used to render a single `setWidget` line and nothing else: no order, no iteration, and no way
// to see what a subagent actually did. gentle-pi keeps that iteration on disk, one pair of files per Pi
// incarnation under `<agentHome>/gentle-agents/presence/`, so the bridge reads it and projects it into
// two shapes: a list for the tab and one run for the modal.
//
// What is at stake: the presence directory is shared by every thread on the machine, so a read that
// followed the newest file instead of the open session would show one chat's subagents in another. And
// these files are written by a process this bridge does not control, so a half-written or hostile
// payload must read as nothing rather than throw inside a request.

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { AgentDetail, AgentList, ServerMessage } from "@gentle-shell/protocol";
import { agentDetail, listAgents, projectAgents } from "../src/agents.ts";
import { startBridgeServer } from "../src/server.ts";

const ZERO_COUNTS = { running: 0, queued: 0, waiting: 0, finished: 0 };

/** A scratch agent home with an empty presence directory; the test removes it afterwards. */
function scratch(home = "gentle-agents-"): { agentHome: string; dir: string } {
	const agentHome = mkdtempSync(join(tmpdir(), home));
	const dir = join(agentHome, "gentle-agents", "presence");
	mkdirSync(dir, { recursive: true });
	return { agentHome, dir };
}

/** One task entry as the presence file writes it. */
function task(id: string, summary: Record<string, unknown> = {}, items: readonly unknown[] = []): unknown {
	return {
		summary: {
			id,
			agent: "gentle-ai-worker",
			label: `run ${id}`,
			status: "running",
			model: "provider/model",
			createdAt: 1_000,
			startedAt: 1_000,
			endedAt: null,
			...summary,
		},
		thread: { version: 1, dropped: 0, items },
	};
}

interface PresenceFile {
	readonly sessionId?: string;
	readonly tasks: readonly unknown[];
	readonly counts?: Record<string, number>;
	readonly heartbeat?: number;
}

/** The hash gentle-pi names the files after: sha256 of the session id. */
function hashOf(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex");
}

/** Write the three sibling files one Pi incarnation leaves behind. */
function writePresence(dir: string, incarnation: string, file: PresenceFile): string {
	const hash = file.sessionId === undefined ? incarnation.padEnd(64, "0").slice(0, 64) : hashOf(file.sessionId);
	const base = join(dir, `${hash}.${incarnation}`);
	const discovery =
		file.sessionId === undefined
			? { schema: 1, sessionHash: hash, incarnation, metadata: { workspace: "/tmp" } }
			: { schema: 1, sessionHash: hash, incarnation, metadata: { workspace: "/tmp", state: { sessionId: file.sessionId } } };
	writeFileSync(`${base}.activity.json`, JSON.stringify({ schema: 1, sessionHash: hash, incarnation, generation: 1, activity: { tasks: file.tasks } }));
	writeFileSync(
		`${base}.header.json`,
		JSON.stringify({ schema: 1, sessionHash: hash, incarnation, heartbeat: file.heartbeat ?? 1, counts: file.counts ?? ZERO_COUNTS }),
	);
	writeFileSync(`${base}.discovery.json`, JSON.stringify(discovery));
	return `${base}.activity.json`;
}

/** Set a file's mtime, so "newest" is decided by the test and not by how fast the disk wrote. */
function touch(path: string, seconds: number): void {
	utimesSync(path, seconds, seconds);
}

/** The session path Pi hands the UI: `<stamp>_<sessionId>.jsonl`. */
function sessionPathOf(sessionId: string): string {
	return `/home/someone/.gentle-shell/agent/sessions/--work--/2026-11-08T19-44-08-998Z_${sessionId}.jsonl`;
}

test("tasks are newest first with ties broken by id, whatever order the file wrote them", () => {
	const projection = projectAgents({
		activity: {
			activity: {
				tasks: [
					task("b", { startedAt: 100, createdAt: 100 }),
					task("c", { startedAt: 300, createdAt: 300 }),
					task("a", { startedAt: 100, createdAt: 100 }),
					task("d", { startedAt: null, createdAt: 50 }),
				],
			},
		},
		header: { counts: { running: 4, queued: 0, waiting: 0, finished: 0 } },
		discovery: null,
	});

	assert.deepEqual(
		projection.tasks.map((entry) => entry.id),
		["c", "b", "a", "d"],
		"newest first, and two runs that started together keep a stable order",
	);
	assert.equal(projection.truncated, false);
});

test("a run keeps its iteration in the order it happened", () => {
	const projection = projectAgents({
		activity: {
			activity: {
				tasks: [
					task("one", {}, [
						{ kind: "text", text: "reading the spec" },
						{ kind: "tool", callId: "call_1", name: "read", output: "# Spec" },
						{ kind: "text", text: "now the tests" },
					]),
				],
			},
		},
		header: { counts: { running: 1, queued: 0, waiting: 0, finished: 0 } },
		discovery: null,
	});

	const run = projection.tasks[0];
	assert.ok(run);
	assert.deepEqual(run.items, [
		{ kind: "text", text: "reading the spec" },
		{ kind: "tool", name: "read", output: "# Spec" },
		{ kind: "text", text: "now the tests" },
	]);
	assert.equal(run.model, "provider/model");
	assert.equal(run.startedAt, 1_000);
	assert.equal(run.endedAt, null);
});

test("a half-written or hostile payload reads as nothing instead of throwing", () => {
	const hostile: readonly unknown[] = [
		{ activity: null, header: null, discovery: null },
		{ activity: 42, header: "text", discovery: [] },
		{ activity: { activity: "nope" }, header: { counts: "nope" }, discovery: null },
		{ activity: { activity: { tasks: [null, 1, "x", [], {}, { summary: {} }, { summary: { id: "" } }] } }, header: null, discovery: null },
	];
	for (const presence of hostile) {
		const projection = projectAgents(presence as never);
		assert.deepEqual(projection.counts, ZERO_COUNTS);
		assert.deepEqual(projection.tasks, []);
		assert.equal(projection.truncated, false);
	}

	const mixed = projectAgents({
		activity: { activity: { tasks: [task("keep"), { summary: { id: "" } }, { summary: { id: 7 } }, { thread: {} }] } },
		header: null,
		discovery: null,
	});
	assert.deepEqual(
		mixed.tasks.map((entry) => entry.id),
		["keep"],
		"an entry without a usable id is dropped, the rest survive",
	);
	assert.deepEqual(mixed.counts, ZERO_COUNTS, "an unreadable header is zero, never a guess");
});

test("a long item is clamped, a long thread keeps its last items, and both are reported", () => {
	const projection = projectAgents(
		{
			activity: {
				activity: {
					tasks: [
						task("one", {}, [
							{ kind: "text", text: "step 0" },
							{ kind: "text", text: "step 1" },
							{ kind: "text", text: "0123456789abcdefghij" },
							{ kind: "tool", callId: "c", name: "bash", output: "abcdefghij0123456789" },
						]),
					],
				},
			},
			header: { counts: { running: 1, queued: 0, waiting: 0, finished: 0 } },
			discovery: null,
		},
		{ maxItems: 2, maxItemChars: 6 },
	);

	assert.deepEqual(projection.tasks[0]?.items, [
		{ kind: "text", text: "…efghij" },
		{ kind: "tool", name: "bash", output: "…456789" },
	]);
	assert.equal(projection.truncated, true, "the caller has to be able to say it was clipped");
});

test("a payload that fits reports no truncation", () => {
	const projection = projectAgents({
		activity: { activity: { tasks: [task("one", {}, [{ kind: "text", text: "short" }])] } },
		header: { counts: { running: 1, queued: 0, waiting: 0, finished: 0 } },
		discovery: null,
	});
	assert.equal(projection.truncated, false);
	assert.deepEqual(projection.tasks[0]?.items, [{ kind: "text", text: "short" }]);
});

test("the counts come from the header the agent published", () => {
	const projection = projectAgents({
		activity: { activity: { tasks: [task("one")] } },
		header: { counts: { running: 1, queued: 2, waiting: 3, finished: 4 } },
		discovery: null,
	});
	assert.deepEqual(projection.counts, { running: 1, queued: 2, waiting: 3, finished: 4 });
});

test("the reader follows the open session, not the newest file on disk", async (t) => {
	const s = scratch();
	t.after(() => rmSync(s.agentHome, { recursive: true, force: true }));
	const mine = "01a1bcb0-8b26-7462-a842-11c2f5f0e641";
	const otherId = "0badbeef-0000-7000-8000-000000000000";
	const minePath = writePresence(s.dir, "inc-mine", {
		sessionId: mine,
		tasks: [task("mine")],
		counts: { running: 1, queued: 0, waiting: 0, finished: 2 },
	});
	const otherPath = writePresence(s.dir, "inc-other", { sessionId: otherId, tasks: [task("other")] });
	// The other thread's file is newer: recency alone must not win.
	touch(minePath, 1_000);
	touch(otherPath, 2_000);

	const list = await listAgents({ agentHome: s.agentHome, sessionPath: sessionPathOf(mine) });
	assert.deepEqual(list.tasks.map((entry) => entry.id), ["mine"]);
	assert.deepEqual(list.counts, { running: 1, queued: 0, waiting: 0, finished: 2 });
	assert.equal("items" in (list.tasks[0] as object), false, "the list carries no iteration");

	const theirs = await listAgents({ agentHome: s.agentHome, sessionPath: sessionPathOf(otherId) });
	assert.deepEqual(theirs.tasks.map((entry) => entry.id), ["other"], "each session reads its own run");
});

test("a presence file whose discovery says nothing about its session is still found by its hash", async (t) => {
	const s = scratch();
	t.after(() => rmSync(s.agentHome, { recursive: true, force: true }));
	const mine = "01a1bcb0-8b26-7462-a842-11c2f5f0e641";
	// Only 20 of the 231 discovery files on this machine carry `metadata.state`; the file name always does.
	const path = join(s.dir, `${hashOf(mine)}.inc-quiet.activity.json`);
	writeFileSync(path, JSON.stringify({ schema: 1, sessionHash: hashOf(mine), incarnation: "inc-quiet", generation: 1, activity: { tasks: [task("quiet")] } }));

	const list = await listAgents({ agentHome: s.agentHome, sessionPath: sessionPathOf(mine) });
	assert.deepEqual(list.tasks.map((entry) => entry.id), ["quiet"]);
});

test("an incarnation named after another hash is still found by what its discovery recorded", async (t) => {
	const s = scratch();
	t.after(() => rmSync(s.agentHome, { recursive: true, force: true }));
	const mine = "01a1bcb0-8b26-7462-a842-11c2f5f0e641";
	const activityPath = join(s.dir, `${"f".repeat(64)}.inc-named.activity.json`);
	writeFileSync(activityPath, JSON.stringify({ schema: 1, sessionHash: "f".repeat(64), incarnation: "inc-named", generation: 1, activity: { tasks: [task("named")] } }));
	writeFileSync(
		join(s.dir, `${"f".repeat(64)}.inc-named.discovery.json`),
		JSON.stringify({ schema: 1, metadata: { workspace: "/tmp", state: { sessionId: mine } } }),
	);

	const list = await listAgents({ agentHome: s.agentHome, sessionPath: sessionPathOf(mine) });
	assert.deepEqual(list.tasks.map((entry) => entry.id), ["named"]);
});

test("with no session open the newest activity file answers", async (t) => {
	const s = scratch();
	t.after(() => rmSync(s.agentHome, { recursive: true, force: true }));
	const older = writePresence(s.dir, "inc-older", { tasks: [task("older")] });
	const newer = writePresence(s.dir, "inc-newer", { tasks: [task("newer")] });
	touch(older, 1_000);
	touch(newer, 2_000);

	const list = await listAgents({ agentHome: s.agentHome });
	assert.deepEqual(list.tasks.map((entry) => entry.id), ["newer"]);
});

test("a missing presence directory reads as nothing instead of throwing", async (t) => {
	const agentHome = mkdtempSync(join(tmpdir(), "gentle-agents-empty-"));
	t.after(() => rmSync(agentHome, { recursive: true, force: true }));

	assert.deepEqual(await listAgents({ agentHome }), { counts: ZERO_COUNTS, tasks: [] });
	assert.deepEqual(await listAgents({ agentHome: join(agentHome, "no-such-home") }), { counts: ZERO_COUNTS, tasks: [] });
	await assert.rejects(() => agentDetail({ agentHome, taskId: "one" }), /agent run/);
});

test("a session with no presence file reads as nothing rather than another thread's run", async (t) => {
	const s = scratch();
	t.after(() => rmSync(s.agentHome, { recursive: true, force: true }));
	writePresence(s.dir, "inc-other", { sessionId: "0badbeef-0000-7000-8000-000000000000", tasks: [task("other")] });

	const list = await listAgents({ agentHome: s.agentHome, sessionPath: sessionPathOf("01a1bcb0-8b26-7462-a842-11c2f5f0e641") });
	assert.deepEqual(list.tasks, []);
	assert.deepEqual(list.counts, ZERO_COUNTS);
});

test("an activity file that resolves outside the presence directory is refused", async (t) => {
	const s = scratch();
	const outside = scratch("gentle-agents-outside-");
	t.after(() => {
		rmSync(s.agentHome, { recursive: true, force: true });
		rmSync(outside.agentHome, { recursive: true, force: true });
	});
	const escaped = join(outside.dir, "escaped.activity.json");
	writeFileSync(escaped, JSON.stringify({ schema: 1, activity: { tasks: [task("escaped")] } }));
	symlinkSync(escaped, join(s.dir, `${"0".repeat(64)}.inc-link.activity.json`));

	const list = await listAgents({ agentHome: s.agentHome });
	assert.deepEqual(list.tasks, [], "a path outside the presence directory is not read");
});

test("one run answers with its iteration, clamped, and an unknown run is an error", async (t) => {
	const s = scratch();
	t.after(() => rmSync(s.agentHome, { recursive: true, force: true }));
	const mine = "01a1bcb0-8b26-7462-a842-11c2f5f0e641";
	writePresence(s.dir, "inc-mine", {
		sessionId: mine,
		tasks: [task("mine", { status: "completed", endedAt: 2_000 }, [{ kind: "tool", callId: "c", name: "bash", output: "x".repeat(5_000) }]), task("older", { startedAt: 10, createdAt: 10 })],
	});

	const detail = await agentDetail({ agentHome: s.agentHome, sessionPath: sessionPathOf(mine), taskId: "mine" });
	assert.equal(detail.id, "mine");
	assert.equal(detail.status, "completed");
	assert.equal(detail.items.length, 1);
	assert.equal(detail.truncated, true);
	const item = detail.items[0];
	assert.ok(item?.kind === "tool");
	assert.equal(item.name, "bash");
	assert.equal(item.output.length, 4_001, "the output keeps a bounded tail");
	assert.ok(item.output.startsWith("…"));

	await assert.rejects(() => agentDetail({ agentHome: s.agentHome, sessionPath: sessionPathOf(mine), taskId: "nope" }), /agent run/);
});

test("the bridge answers the agents family over the websocket", async (t) => {
	const s = scratch();
	t.after(() => rmSync(s.agentHome, { recursive: true, force: true }));
	const mine = "01a1bcb0-8b26-7462-a842-11c2f5f0e641";
	writePresence(s.dir, "inc-mine", {
		sessionId: mine,
		tasks: [task("mine", {}, [{ kind: "text", text: "hello" }])],
		counts: { running: 1, queued: 0, waiting: 0, finished: 0 },
	});
	const server = await startBridgeServer({ workspace: s.agentHome, agents: { agentHome: s.agentHome } });
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	const seen: ServerMessage[] = [];
	ws.on("message", (raw: { toString(): string }) => seen.push(JSON.parse(raw.toString()) as ServerMessage));
	const answer = async (id: string, request: Record<string, unknown>): Promise<ServerMessage> => {
		ws.send(JSON.stringify({ id, ...request }));
		for (let waited = 0; waited < 10_000; waited += 25) {
			const found = seen.find((message) => "id" in message && message.id === id);
			if (found !== undefined) return found;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`no answer to ${id}`);
	};

	try {
		await new Promise((resolve) => ws.on("open", resolve));
		const list = await answer("a1", { kind: "agents", action: "list", sessionPath: sessionPathOf(mine) });
		assert.equal(list.kind, "agents");
		if (list.kind === "agents") {
			const data = list.data as AgentList;
			assert.deepEqual(data.tasks.map((entry) => entry.id), ["mine"]);
			assert.deepEqual(data.counts, { running: 1, queued: 0, waiting: 0, finished: 0 });
			assert.equal("items" in (data.tasks[0] as object), false);
		}

		const detail = await answer("a2", { kind: "agents", action: "detail", sessionPath: sessionPathOf(mine), taskId: "mine" });
		assert.equal(detail.kind, "agents");
		if (detail.kind === "agents") {
			const data = detail.data as AgentDetail;
			assert.deepEqual(data.items, [{ kind: "text", text: "hello" }]);
			assert.equal(data.truncated, false);
		}

		const missing = await answer("a3", { kind: "agents", action: "detail", sessionPath: sessionPathOf(mine), taskId: "nope" });
		assert.equal(missing.kind, "error");

		const unknown = await answer("a4", { kind: "agents", action: "bogus" });
		assert.equal(unknown.kind, "error", "an action the bridge does not know must be answered");
	} finally {
		ws.close();
		await server.close();
	}
});
