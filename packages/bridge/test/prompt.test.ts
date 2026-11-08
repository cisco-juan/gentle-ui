import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ServerMessage } from "@gentle-shell/protocol";
import { PiProcess } from "../src/pi-process.ts";
import { startBridgeServer } from "../src/server.ts";

const ANSWER_AFTER_MS = 400;

// A Pi that behaves like an extension command waiting on a person: `prompt` emits a notify, then answers
// "handled" only after a delay. Every other command answers at once, except `slow`, which waits too.
const FAKE_PI = `#!/usr/bin/env node
const readline = require("node:readline");
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const reply = (message, data) => out({ id: message.id, type: "response", command: message.type, success: true, data });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.type === "extension_ui_response") return;
	if (message.type === "prompt") {
		out({ type: "extension_ui_request", id: "note-1", method: "notify", message: "hello", notifyType: "info" });
		setTimeout(() => reply(message, { disposition: "handled" }), ${ANSWER_AFTER_MS});
		return;
	}
	if (message.type === "slow") {
		setTimeout(() => reply(message, {}), ${ANSWER_AFTER_MS});
		return;
	}
	reply(message, {});
});
`;

function fakePi(): string {
	const path = join(mkdtempSync(join(tmpdir(), "gentle-fake-pi-")), "pi");
	writeFileSync(path, FAKE_PI);
	chmodSync(path, 0o755);
	return path;
}

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "gentle-bridge-ws-"));
}

test("a command with no timeout outlives the clock that fails every other command", async () => {
	const pi = new PiProcess({ cwd: workspace(), executable: fakePi(), requestTimeoutMs: 100 });
	pi.start();
	try {
		await assert.rejects(() => pi.send("slow"), /did not answer "slow" within 100ms/);
		const answer = await pi.send<{ disposition: string }>("prompt", {}, null);
		assert.equal(answer.disposition, "handled");
	} finally {
		await pi.stop();
	}
});

test("a record that is not a dialog reaches the websocket once", async () => {
	const server = await startBridgeServer({ executable: fakePi() });
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	const seen: ServerMessage[] = [];
	ws.on("message", (raw: { toString(): string }) => seen.push(JSON.parse(raw.toString()) as ServerMessage));
	try {
		await new Promise((resolve) => ws.on("open", resolve));
		const opened = await waitFor(seen, ws, (message) => message.kind === "opened", () =>
			ws.send(JSON.stringify({ kind: "open", id: "open-1", cwd: workspace() })),
		);
		assert.equal(opened.kind, "opened");

		const threadId = opened.kind === "opened" ? opened.threadId : "";
		const result = await waitFor(seen, ws, (message) => message.kind === "result" && message.id === "cmd-1", () =>
			ws.send(JSON.stringify({ kind: "command", id: "cmd-1", threadId, command: "prompt", params: { message: "/x" } })),
		);
		assert.equal(result.kind === "result" && result.ok, true);

		const notices = seen.filter(
			(message) => message.kind === "record" && (message.record as { id?: string }).id === "note-1",
		);
		assert.equal(notices.length, 1, "the notify arrived more than once");
	} finally {
		ws.close();
		await server.close();
	}
});

/** Resolve with the first message after `start` that matches, scanning what already arrived too. */
function waitFor(
	seen: ServerMessage[],
	ws: WebSocket,
	match: (message: ServerMessage) => boolean,
	start: () => void,
	timeoutMs = 10_000,
): Promise<ServerMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.off("message", check);
			reject(new Error("timed out waiting for a matching bridge message"));
		}, timeoutMs);
		function check(): void {
			const found = seen.find(match);
			if (found === undefined) return;
			clearTimeout(timer);
			ws.off("message", check);
			resolve(found);
		}
		ws.on("message", check);
		start();
	});
}
