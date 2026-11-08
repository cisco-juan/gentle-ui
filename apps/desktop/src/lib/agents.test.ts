// The Agents tab: newest first, one run opened at a time, and nothing left over from the previous thread.
//
// Two rules are worth a test here. The first is order: the bridge already sorts newest first, and the UI
// has to keep that order instead of grouping by status, which would sink a failed run below a running
// one and make the list move while an agent works. The second is scope: the inspector is one panel
// reused by every thread, so a list read for thread A must never be rendered while thread B is open, and
// an answer that arrives after the switch must be dropped rather than applied to the new thread.

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCounts, AgentDetail, AgentList, AgentTaskSummary, ServerMessage } from "@gentle-shell/protocol";
import type { BridgeClient } from "./bridge.ts";
import { agentCountsLabel, agentDuration, agentOrder } from "./agents.ts";
import { createInspector } from "../state/inspector.ts";

const ZERO: AgentCounts = { running: 0, queued: 0, waiting: 0, finished: 0 };

function summary(id: string, over: Partial<AgentTaskSummary> = {}): AgentTaskSummary {
	return {
		id,
		agent: "gentle-ai-worker",
		label: `run ${id}`,
		status: "running",
		model: "provider/model",
		createdAt: 1_000,
		startedAt: 1_000,
		endedAt: null,
		...over,
	};
}

function list(tasks: readonly AgentTaskSummary[], counts: Partial<AgentCounts> = {}): AgentList {
	return { counts: { ...ZERO, ...counts }, tasks };
}

function detail(id: string): AgentDetail {
	return {
		id,
		agent: "gentle-ai-worker",
		label: `run ${id}`,
		status: "completed",
		items: [
			{ kind: "text", text: "reading the spec" },
			{ kind: "tool", name: "bash", output: "ok" },
		],
		truncated: false,
	};
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** Let a settled promise chain finish; nothing here waits on a timer of its own. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A bridge whose agents answers are handed out by the test, in the order it asks for them. */
function fakeBridge() {
	const lists: Array<{ request: { action: string; sessionPath?: string }; pending: Deferred<AgentList> }> = [];
	const details: Array<{ request: { action: string; sessionPath?: string; taskId: string }; pending: Deferred<AgentDetail> }> = [];
	const listeners: Array<(message: ServerMessage) => void> = [];

	const client = {
		agents(request: { action: "list"; sessionPath?: string } | { action: "detail"; sessionPath?: string; taskId: string }) {
			if (request.action === "detail") {
				const pending = deferred<AgentDetail>();
				details.push({ request, pending });
				return pending.promise;
			}
			const pending = deferred<AgentList>();
			lists.push({ request, pending });
			return pending.promise;
		},
		subscribe(listener: (message: ServerMessage) => void): () => void {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
	};

	return { client: client as unknown as BridgeClient, lists, details, listeners };
}

function widgetUpdate(text: string): ServerMessage {
	return {
		kind: "record",
		threadId: "thread-1",
		record: {
			type: "extension_ui_request",
			method: "setWidget",
			widgetKey: "gentle-agents",
			widgetLines: [text],
		},
	};
}

test("the list keeps the bridge's newest-first order and never re-sorts by status", () => {
	const rows = [
		summary("b", { startedAt: 100 }),
		summary("a", { startedAt: 100 }),
		summary("c", { startedAt: 300, status: "completed" }),
		summary("d", { startedAt: null, createdAt: 50 }),
	];
	assert.deepEqual(
		agentOrder(rows).map((row) => row.id),
		["c", "b", "a", "d"],
	);
	assert.deepEqual(
		agentOrder([summary("z", { startedAt: 9, status: "failed" }), summary("y", { startedAt: 1, status: "running" })]).map((row) => row.id),
		["z", "y"],
		"a failed run keeps its place in time instead of sinking below a running one",
	);
	assert.deepEqual(agentOrder([]), []);
});

test("the counts line says what is running and what finished", () => {
	assert.equal(agentCountsLabel({ running: 1, queued: 0, waiting: 0, finished: 2 }), "1 running · 2 finished");
	assert.equal(agentCountsLabel({ running: 0, queued: 2, waiting: 1, finished: 0 }), "0 running · 2 queued · 1 waiting · 0 finished");
	assert.equal(agentCountsLabel(ZERO), "", "nothing to say when nothing ran");
});

test("a run's duration comes from its own timestamps", () => {
	assert.equal(agentDuration(summary("a", { startedAt: 1_000, endedAt: 13_500 })), "13s");
	assert.equal(agentDuration(summary("b", { startedAt: 1_000, endedAt: null }), 181_000), "3m00s", "a running run is timed to now");
	assert.equal(agentDuration(summary("c", { startedAt: null, createdAt: null })), null);
});

test("opening the tab reads the list for the thread that is open", async () => {
	const bridge = fakeBridge();
	let path: string | null = "/sessions/one.jsonl";
	const inspector = createInspector({ connect: () => bridge.client, activePath: () => path });

	inspector.select("agents");
	assert.equal(bridge.lists.length, 1);
	assert.equal(bridge.lists[0]?.request.sessionPath, "/sessions/one.jsonl");

	bridge.lists[0]?.pending.resolve(list([summary("b", { startedAt: 100 }), summary("a", { startedAt: 200 })], { running: 2 }));
	await settle();

	assert.deepEqual(inspector.agents().tasks.map((entry) => entry.id), ["a", "b"]);
	assert.deepEqual(inspector.agents().counts, { running: 2, queued: 0, waiting: 0, finished: 0 });
	assert.equal(inspector.agents().loading, false);
	assert.equal(inspector.agents().error, null);
});

test("a widget update is the trigger, and the widget payload is never the list", async () => {
	const bridge = fakeBridge();
	const inspector = createInspector({ connect: () => bridge.client, activePath: () => "/sessions/one.jsonl" });

	inspector.select("agents");
	bridge.lists[0]?.pending.resolve(list([], { running: 0 }));
	await settle();

	// The widget still carries the counters gentle-pi publishes; they must not be what the tab shows.
	bridge.listeners[0]?.(
		widgetUpdate(JSON.stringify({ schema: "gentle-agents.activity/v1", summary: { running: 9, queued: 9, waiting: 9, finished: 9 }, tasks: [] })),
	);
	assert.equal(bridge.lists.length, 2, "the update makes the tab re-read");
	assert.equal(inspector.agents().counts.running, 0, "the counts come from the bridge, not the widget");
	await settle();
});

test("switching threads empties the tab and closes the open run", async () => {
	const bridge = fakeBridge();
	let path: string | null = "/sessions/one.jsonl";
	const inspector = createInspector({ connect: () => bridge.client, activePath: () => path });

	inspector.select("agents");
	bridge.lists[0]?.pending.resolve(list([summary("a")], { running: 1 }));
	await settle();

	const opening = inspector.openAgent("a");
	assert.equal(bridge.details[0]?.request.taskId, "a");
	assert.equal(bridge.details[0]?.request.sessionPath, "/sessions/one.jsonl");
	bridge.details[0]?.pending.resolve(detail("a"));
	await opening;
	assert.equal(inspector.agentDetail()?.data?.id, "a");

	path = "/sessions/two.jsonl";
	assert.deepEqual(inspector.agents(), { counts: ZERO, tasks: [], loading: false, error: null }, "the previous thread's run is gone");
	assert.equal(inspector.agentDetail(), null, "and its modal is closed");
});

test("a read for the new thread never shows the previous thread's rows while it is in flight", async () => {
	const bridge = fakeBridge();
	let path: string | null = "/sessions/one.jsonl";
	const inspector = createInspector({ connect: () => bridge.client, activePath: () => path });

	inspector.select("agents");
	bridge.lists[0]?.pending.resolve(list([summary("a")], { running: 1 }));
	await settle();
	assert.deepEqual(inspector.agents().tasks.map((entry) => entry.id), ["a"]);

	path = "/sessions/two.jsonl";
	const reloading = inspector.refresh();
	assert.deepEqual(inspector.agents().tasks, [], "not even while the new thread is being read");
	assert.equal(inspector.agents().loading, true);

	bridge.lists[1]?.pending.resolve(list([summary("b")], { running: 1 }));
	await reloading;
	assert.deepEqual(inspector.agents().tasks.map((entry) => entry.id), ["b"]);
});

test("an answer that arrives after the switch never lands on the new thread", async () => {
	const bridge = fakeBridge();
	let path: string | null = "/sessions/one.jsonl";
	const inspector = createInspector({ connect: () => bridge.client, activePath: () => path });

	inspector.select("agents");
	const first = bridge.lists[0];
	assert.ok(first);
	path = "/sessions/two.jsonl";
	first.pending.resolve(list([summary("a")], { running: 1 }));
	await settle();
	assert.deepEqual(inspector.agents().tasks, [], "the read that belonged to the previous thread is dropped");

	const reloading = inspector.refresh();
	assert.equal(bridge.lists[1]?.request.sessionPath, "/sessions/two.jsonl");
	bridge.lists[1]?.pending.resolve(list([summary("b")], { running: 1 }));
	await reloading;
	assert.deepEqual(inspector.agents().tasks.map((entry) => entry.id), ["b"]);
});

test("a run that cannot be read says so in the modal, and closing forgets it", async () => {
	const bridge = fakeBridge();
	const inspector = createInspector({ connect: () => bridge.client, activePath: () => "/sessions/one.jsonl" });

	inspector.select("agents");
	bridge.lists[0]?.pending.resolve(list([summary("a")]));
	await settle();

	const opening = inspector.openAgent("a");
	assert.equal(inspector.agentDetail()?.loading, true);
	bridge.details[0]?.pending.reject(new Error("the run is gone"));
	await opening;

	assert.equal(inspector.agentDetail()?.data, null);
	assert.equal(inspector.agentDetail()?.error, "the run is gone");
	assert.equal(inspector.agentDetail()?.summary?.label, "run a", "the header still describes the row that was clicked");

	inspector.closeAgent();
	assert.equal(inspector.agentDetail(), null);
});
