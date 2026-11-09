import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { BridgeClient } from "./bridge.ts";

type Handler = (event: { data?: unknown }) => void;

/** Just enough of a WebSocket to drive the client: the test decides when it opens and when it drops. */
class FakeSocket {
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	static last: FakeSocket;
	readyState = 0;
	readonly sent: string[] = [];
	readonly #handlers = new Map<string, Handler[]>();

	readonly url: string;

	constructor(url: string) {
		this.url = url;
		FakeSocket.last = this;
	}

	addEventListener(type: string, handler: Handler): void {
		this.#handlers.set(type, [...(this.#handlers.get(type) ?? []), handler]);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.drop();
	}

	open(): void {
		this.readyState = FakeSocket.OPEN;
		this.#emit("open");
	}

	/** The bridge sends one message. */
	message(payload: unknown): void {
		for (const handler of this.#handlers.get("message") ?? []) handler({ data: JSON.stringify(payload) });
	}

	/** The connection ends without the client asking: the bridge died or the network went. */
	drop(): void {
		this.readyState = FakeSocket.CLOSED;
		this.#emit("close");
	}

	#emit(type: string): void {
		for (const handler of this.#handlers.get(type) ?? []) handler({});
	}
}

const real = globalThis.WebSocket;

beforeEach(() => {
	(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
});

afterEach(() => {
	(globalThis as unknown as { WebSocket: unknown }).WebSocket = real;
});

async function opened(): Promise<{ client: BridgeClient; socket: FakeSocket }> {
	const client = new BridgeClient("ws://bridge.test");
	const connecting = client.connect();
	FakeSocket.last.open();
	await connecting;
	return { client, socket: FakeSocket.last };
}

test("a dropped connection tells the listeners once", async () => {
	const { client, socket } = await opened();
	let closed = 0;
	client.onClose(() => closed++);
	socket.drop();
	assert.equal(closed, 1);
	assert.equal(client.connected, false);
});

test("a close the client asked for is not reported as a loss", async () => {
	const { client } = await opened();
	let closed = 0;
	client.onClose(() => closed++);
	client.close();
	assert.equal(closed, 0);
});

test("a request waiting when the connection drops is rejected", async () => {
	const { client, socket } = await opened();
	const waiting = client.command("thread-1", "get_state");
	socket.drop();
	await assert.rejects(waiting, /bridge connection closed/);
});

test("answering a dialog on a dropped connection fails loudly", async () => {
	const { client, socket } = await opened();
	socket.drop();
	assert.throws(() => client.answer("thread-1", "req-1", { confirmed: true }), /bridge is not connected/);
});

test("a listener that is removed hears nothing", async () => {
	const { client, socket } = await opened();
	let closed = 0;
	const stop = client.onClose(() => closed++);
	stop();
	socket.drop();
	assert.equal(closed, 0);
});

test("a profiles answer settles the request that asked for it", async () => {
	const { client, socket } = await opened();
	const waiting = client.profiles({ action: "list" });
	const sent = JSON.parse(socket.sent[0] as string) as { id: string; kind: string; action: string };
	assert.equal(sent.kind, "profiles");
	assert.equal(sent.action, "list");

	socket.message({ kind: "profiles", id: sent.id, action: "list", data: { state: "ok", profiles: [] } });
	assert.deepEqual(await waiting, { state: "ok", profiles: [] });
});

test("a refused profiles change rejects with the bridge's message", async () => {
	const { client, socket } = await opened();
	const waiting = client.profiles({ action: "create", name: "alpha" });
	const sent = JSON.parse(socket.sent[0] as string) as { id: string };

	socket.message({ kind: "error", id: sent.id, message: "Profile already exists: alpha." });
	await assert.rejects(waiting, /already exists/);
});

test("a permissions answer settles the request that asked for it", async () => {
	const { client, socket } = await opened();
	const waiting = client.permissions({ action: "status" });
	const sent = JSON.parse(socket.sent[0] as string) as { id: string; kind: string; action: string };
	assert.equal(sent.kind, "permissions");
	assert.equal(sent.action, "status");

	socket.message({ kind: "permissions", id: sent.id, action: "status", data: { state: "ok", default: "normal" } });
	assert.deepEqual(await waiting, { state: "ok", default: "normal" });
});

const ASSESSMENT = {
	risk: "medium",
	reasons: [],
	changedPaths: 0,
	changedLines: 0,
	candidateKind: "current-changes",
	candidateConsumed: false,
	reviewDue: false,
	reviewDueReason: "",
};

/**
 * The assess wire payload, in all three shapes the panel can ask for.
 *
 * This class of drop is invisible without pinning the payload: the old client accepted `baseRef`
 * through a spread and silently sent `{kind, id, action}` only, so T39's panel path never reached
 * the bridge.
 */
test("review assess forwards the base ref and the relayed untracked declaration", async () => {
	const declaration = [
		"--untracked-scope=select",
		"--expected-untracked-inventory=sha256:cc090fa97db9cb7239a0572b1c12c94ecb94fe5417ee421e78337b49f8484926",
		"--intended-untracked=docs/notes.md",
	];
	const cases: readonly {
		readonly request: { readonly action: "assess"; readonly baseRef?: string; readonly untracked?: readonly string[] };
		readonly expected: Record<string, unknown>;
	}[] = [
		{ request: { action: "assess" }, expected: {} },
		{ request: { action: "assess", baseRef: "HEAD~1" }, expected: { baseRef: "HEAD~1" } },
		{ request: { action: "assess", untracked: declaration }, expected: { untracked: declaration } },
		{ request: { action: "assess", baseRef: "HEAD~1", untracked: declaration }, expected: { baseRef: "HEAD~1", untracked: declaration } },
	];

	for (const { request, expected } of cases) {
		const { client, socket } = await opened();
		const waiting = client.review(request);
		const sent = JSON.parse(socket.sent[0] as string) as { id: string };

		assert.deepEqual(JSON.parse(socket.sent[0] as string), {
			kind: "review",
			id: sent.id,
			action: "assess",
			...expected,
		});

		socket.message({ kind: "review", id: sent.id, action: "assess", data: ASSESSMENT });
		assert.deepEqual(await waiting, ASSESSMENT);
	}
});

/**
 * The reviewer run's own wire payload.
 *
 * `model` and `context` are exactly what a spread can drop, and a run started on the wrong model
 * spends the user's own credits: both are pinned whole, not just the action.
 */
test("review reviewer-run forwards the model and the lens context unchanged", async () => {
	const { client, socket } = await opened();
	const model = "openrouter/anthropic/claude-sonnet-4.5";
	const context = "- LENS review-reliability\nRead `src/App.tsx` and report the findings.";
	const waiting = client.review({ action: "reviewer-run", model, context });
	const sent = JSON.parse(socket.sent[0] as string) as { id: string };

	assert.deepEqual(sent, { kind: "review", id: sent.id, action: "reviewer-run", model, context });

	const answer = { text: "verdict: no findings", exitCode: 0, durationMs: 1234, truncated: false };
	socket.message({ kind: "review", id: sent.id, action: "reviewer-run", data: answer });
	assert.deepEqual(await waiting, answer);
});

/**
 * The three verbs a reviewer collect hands out, pinned on the wire.
 *
 * The payload is the part a spread can silently drop — `review()` sent `{kind, id, action}` and
 * nothing else for a long time (L20) — so each shape is asserted whole, with the provider's own
 * tokens and the reviewer result expected to reach the wire unchanged.
 */
test("review forwards the lens-context, capture-result and acknowledge payloads unchanged", async () => {
	const tokens = [
		"--lineage=review-b005087be055cc9b",
		"--expected-revision=sha256:6f2348017329fd5a96c65509735324539ed1e90656dfe107372bc3ab174e603f",
		"--lens=review-reliability",
		"--order=0",
	];
	const result = {
		subject_hash: `sha256:${"4".repeat(64)}`,
		inspection: { status: "completed", paths: ["src/App.tsx"] },
		findings: [],
		evidence: ["read src/App.tsx"],
	};
	const cases: readonly {
		readonly send: (client: BridgeClient) => Promise<unknown>;
		readonly action: string;
		readonly payload: Record<string, unknown>;
		readonly answer: unknown;
	}[] = [
		{
			send: (client) => client.review({ action: "lens-context", tokens }),
			action: "lens-context",
			payload: { tokens },
			answer: { lens: "review-reliability", context: "the provider's own context" },
		},
		{
			send: (client) => client.review({ action: "capture-result", tokens, result, dryRun: true }),
			action: "capture-result",
			payload: { tokens, result, dryRun: true },
			answer: { dryRun: true, output: '{"validation":"accepted"}' },
		},
		// The same submission without its dry run: the optional field is left off, not sent as false.
		{
			send: (client) => client.review({ action: "capture-result", tokens, result }),
			action: "capture-result",
			payload: { tokens, result },
			answer: { dryRun: false, output: '{"schema":"captured"}' },
		},
		{
			send: (client) => client.review({ action: "acknowledge", tokens }),
			action: "acknowledge",
			payload: { tokens },
			answer: { output: '{"schema":"gentle-ai.review-acknowledged/v1"}' },
		},
	];

	for (const { send, action, payload, answer } of cases) {
		const { client, socket } = await opened();
		const waiting = send(client);
		const sent = JSON.parse(socket.sent[0] as string) as { id: string };

		assert.deepEqual(sent, { kind: "review", id: sent.id, action, ...payload });
		assert.equal(socket.sent.length, 1, "one request, and nothing else on the wire");

		socket.message({ kind: "review", id: sent.id, action, data: answer });
		assert.deepEqual(await waiting, answer);
	}
});
