import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ServerMessage } from "@gentle-shell/protocol";
import { startBridgeServer } from "../src/server.ts";

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "gentle-bridge-ws-"));
}

/** Resolve with the first message that matches, so tests never depend on message order. */
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

function connect(port: number, token: string): WebSocket {
	return new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
}

test("opens a thread and forwards a command over the websocket", async () => {
	const server = await startBridgeServer();
	const ws = connect(server.port, server.token);
	try {
		await new Promise((resolve) => ws.on("open", resolve));

		const opened = next(ws, (message) => message.kind === "opened");
		ws.send(JSON.stringify({ kind: "open", id: "open-1", cwd: workspace() }));
		const openResult = await opened;
		assert.equal(openResult.kind, "opened");

		const answered = next(ws, (message) => message.kind === "result" && message.id === "cmd-1");
		ws.send(JSON.stringify({ kind: "command", id: "cmd-1", threadId: openResult.threadId, command: "get_commands" }));
		const result = await answered;
		assert.equal(result.kind === "result" && result.ok, true);
	} finally {
		ws.close();
		await server.close();
	}
});

test("rejects a websocket without the bridge token", async () => {
	const server = await startBridgeServer();
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=wrong`);
	try {
		const error = await new Promise<Error>((resolve) => ws.on("error", resolve));
		assert.match(error.message, /401/);
	} finally {
		ws.terminate();
		await server.close();
	}
});

test("reports an unknown thread instead of hanging", async () => {
	const server = await startBridgeServer();
	const ws = connect(server.port, server.token);
	try {
		await new Promise((resolve) => ws.on("open", resolve));
		const answered = next(ws, (message) => message.kind === "result" && message.id === "cmd-2");
		ws.send(JSON.stringify({ kind: "command", id: "cmd-2", threadId: "nope", command: "get_state" }));
		const result = await answered;
		assert.equal(result.kind === "result" && result.ok, false);
		assert.match(result.kind === "result" ? (result.error ?? "") : "", /unknown thread/);
	} finally {
		ws.close();
		await server.close();
	}
});
