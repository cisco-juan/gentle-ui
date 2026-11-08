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
