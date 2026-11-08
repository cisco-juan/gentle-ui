import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ServerMessage, SessionSummary } from "@gentle-shell/protocol";
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

test("answers a sessions request with the injected index", async () => {
	const items: readonly SessionSummary[] = [
		{ path: "/tmp/one.jsonl", cwd: "/work/one", title: "First thread", updatedAt: 1_700_000_002_000, model: "claude-sonnet" },
		{ path: "/tmp/two.jsonl", cwd: "", title: "Second thread", updatedAt: 1_700_000_001_000 },
	];
	const server = await startBridgeServer({ sessions: async () => items });
	const ws = connect(server.port, server.token);
	try {
		await new Promise((resolve) => ws.on("open", resolve));
		const answered = next(ws, (message) => message.kind === "sessions" && message.id === "list-1");
		ws.send(JSON.stringify({ kind: "sessions", id: "list-1" }));
		const listed = await answered;
		assert.equal(listed.kind, "sessions");
		assert.deepEqual(listed.kind === "sessions" ? listed.items : null, items);
	} finally {
		ws.close();
		await server.close();
	}
});

test("forwards switch_session to pi and surfaces the rejection", async () => {
	const server = await startBridgeServer();
	const ws = connect(server.port, server.token);
	try {
		await new Promise((resolve) => ws.on("open", resolve));

		const opened = next(ws, (message) => message.kind === "opened");
		ws.send(JSON.stringify({ kind: "open", id: "open-2", cwd: workspace() }));
		const openResult = await opened;
		assert.equal(openResult.kind, "opened");

		// A file Pi cannot read as a session makes `switch_session` fail, which proves the command
		// reached the child instead of being answered by the bridge.
		const broken = join(workspace(), "broken.jsonl");
		writeFileSync(broken, "this is not a session\n");

		const answered = next(ws, (message) => message.kind === "result" && message.id === "cmd-3");
		ws.send(
			JSON.stringify({
				kind: "command",
				id: "cmd-3",
				threadId: openResult.threadId,
				command: "switch_session",
				params: { sessionPath: broken },
			}),
		);
		const result = await answered;
		assert.equal(result.kind === "result" && result.ok, false);
		assert.match(result.kind === "result" ? (result.error ?? "") : "", /not a valid pi session/);
	} finally {
		ws.close();
		await server.close();
	}
});

test("resumes a session on open and hands back its history", async () => {
	const cwd = workspace();
	const sessionPath = join(workspace(), "resume.jsonl");
	const now = new Date().toISOString();
	writeFileSync(
		sessionPath,
		`${[
			{ type: "session", version: 3, id: "resume", timestamp: now, cwd },
			{ type: "message", id: "r1", parentId: null, timestamp: now, message: { role: "system", content: "sys", timestamp: 1 } },
			{ type: "message", id: "r2", parentId: "r1", timestamp: now, message: { role: "user", content: [{ type: "text", text: "earlier question" }], timestamp: 2 } },
			{
				type: "message",
				id: "r3",
				parentId: "r2",
				timestamp: now,
				message: { role: "assistant", content: [{ type: "text", text: "earlier answer" }], model: "claude-sonnet", timestamp: 3 },
			},
		]
			.map((line) => JSON.stringify(line))
			.join("\n")}\n`,
	);

	const server = await startBridgeServer();
	const ws = connect(server.port, server.token);
	try {
		await new Promise((resolve) => ws.on("open", resolve));
		const opened = next(ws, (message) => message.kind === "opened");
		ws.send(JSON.stringify({ kind: "open", id: "open-4", cwd, sessionPath }));
		const openResult = await opened;
		assert.equal(openResult.kind, "opened");
		assert.equal(openResult.kind === "opened" ? (openResult.state as { sessionFile?: string }).sessionFile : null, sessionPath);

		const answered = next(ws, (message) => message.kind === "result" && message.id === "cmd-4");
		ws.send(JSON.stringify({ kind: "command", id: "cmd-4", threadId: openResult.threadId, command: "get_messages" }));
		const result = await answered;
		assert.equal(result.kind === "result" && result.ok, true);
		const messages = result.kind === "result" ? ((result.data as { messages?: Array<{ role: string }> }).messages ?? []) : [];
		assert.deepEqual(
			messages.map((message) => message.role),
			["system", "user", "assistant"],
		);
	} finally {
		ws.close();
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

test("answers an unknown message kind instead of blaming a missing thread", async () => {
	const server = await startBridgeServer();
	const ws = connect(server.port, server.token);
	try {
		await new Promise((resolve) => ws.on("open", resolve));
		// An older client asking for something this bridge does not have: the answer must name the kind,
		// not report a thread that was never part of the request.
		const answered = next(ws, (message) => message.kind === "error");
		ws.send(JSON.stringify({ kind: "teleport", id: "kind-1" }));
		const result = await answered;
		assert.match(result.kind === "error" ? result.message : "", /unsupported message kind: teleport/);
	} finally {
		ws.close();
		await server.close();
	}
});
