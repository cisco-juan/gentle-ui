// The permission-mode default, exercised against the gentle-pi library installed on this machine.
//
// What is at stake here is not a preference but an approval: the mode a new thread starts in decides
// whether the agent asks before it acts. So the tests that matter are the refusals. The bridge is
// reachable by any local process that holds its token, the agent itself included, and a request to raise
// the default to yolo must never be a way to remove approvals without a person at a terminal.
//
// Every test works in a scratch config home under the temp directory; nothing touches ~/.gentle-shell.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ServerMessage } from "@gentle-shell/protocol";
import { resolvePiEnvironment } from "../src/pi-environment.ts";
import { permissionsSetDefault, permissionsStatus, type PermissionsOptions } from "../src/permissions.ts";
import { startBridgeServer } from "../src/server.ts";

const EXTENSION = resolvePiEnvironment().extensionPath;
const integration = { skip: EXTENSION === null ? "gentle-pi is not installed on this machine" : false };

const SCHEMA = "gentle-pi.permission-mode/v1";

interface Scratch {
	readonly configHome: string;
	readonly file: string;
	readonly options: PermissionsOptions;
}

function scratch(initial?: string): Scratch {
	const configHome = mkdtempSync(join(tmpdir(), "gentle-permissions-"));
	const file = join(configHome, "permission-mode.json");
	if (initial !== undefined) writeFileSync(file, initial);
	return { configHome, file, options: { configHome, ...(EXTENSION === null ? {} : { extension: EXTENSION }) } };
}

function stored(mode: string): string {
	return `${JSON.stringify({ schema: SCHEMA, mode })}\n`;
}

test("a machine without the library gets a typed unavailable answer, not a guess at the mode", async () => {
	const s = scratch();
	const view = await permissionsStatus({ ...s.options, extension: join(s.configHome, "no-such-gentle-pi") });
	assert.equal(view.state, "unavailable");
	assert.equal(view.reason, "library-missing");
	assert.equal(view.default, null);
});

test("with no file the default is normal, and nothing is created by asking", integration, async () => {
	const s = scratch();
	const view = await permissionsStatus(s.options);
	assert.equal(view.state, "ok");
	assert.equal(view.default, "normal");
	assert.equal(view.stored, false);
	assert.deepEqual(view.settable, ["normal", "auto"]);
	assert.equal(existsSync(s.file), false);
});

test("the stored default is reported, including an elevated one set from a terminal", integration, async () => {
	assert.equal((await permissionsStatus(scratch(stored("auto")).options)).default, "auto");
	const elevated = await permissionsStatus(scratch(stored("yolo")).options);
	assert.equal(elevated.default, "yolo");
	assert.deepEqual(elevated.settable, ["normal", "auto"], "an elevated default does not widen what the UI may set");
});

test("setting auto writes the file in the shape gentle-pi's own reader accepts, readable only by the owner", integration, async () => {
	const s = scratch();
	const view = await permissionsSetDefault("auto", s.options);
	assert.equal(view.default, "auto");
	assert.equal(view.stored, true);
	assert.equal(readFileSync(s.file, "utf8"), stored("auto"));
	assert.equal(statSync(s.file).mode & 0o777, 0o600);
});

test("lowering an elevated default is allowed, since it only adds approvals", integration, async () => {
	const s = scratch(stored("super-yolo"));
	const view = await permissionsSetDefault("normal", s.options);
	assert.equal(view.default, "normal");
	assert.equal(readFileSync(s.file, "utf8"), stored("normal"));
});

test("raising the default to yolo or super-yolo is refused and nothing is written", integration, async () => {
	for (const mode of ["yolo", "super-yolo"] as const) {
		const absent = scratch();
		await assert.rejects(() => permissionsSetDefault(mode, absent.options), /terminal/);
		assert.equal(existsSync(absent.file), false, `${mode} created a file`);

		const present = scratch(stored("normal"));
		await assert.rejects(() => permissionsSetDefault(mode, present.options), /terminal/);
		assert.equal(readFileSync(present.file, "utf8"), stored("normal"), `${mode} changed the file`);
	}
});

test("a value that is not a permission mode is refused before anything is written", integration, async () => {
	const s = scratch(stored("normal"));
	const hostile = ["root", "", " auto", "auto ", "AUTO", "normal\n", "__proto__", "constructor", "yolo\u0000", 3, null, undefined, {}, ["auto"]];
	for (const value of hostile) {
		await assert.rejects(() => permissionsSetDefault(value as never, s.options), /permission mode/, `accepted ${JSON.stringify(value)}`);
	}
	assert.equal(readFileSync(s.file, "utf8"), stored("normal"));
});

test("a preference file gentle-pi cannot read is reported and never replaced", integration, async () => {
	for (const text of ["{not json", JSON.stringify({ schema: SCHEMA, mode: "root" }), JSON.stringify({ schema: "other", mode: "auto" })]) {
		const s = scratch(text);
		const view = await permissionsStatus(s.options);
		assert.equal(view.state, "unavailable", text);
		assert.equal(view.reason, "file-invalid", text);
		assert.equal(view.default, null, "a broken file must not read as normal");

		await assert.rejects(() => permissionsSetDefault("auto", s.options), /repair/);
		assert.equal(readFileSync(s.file, "utf8"), text);
	}
});

test("the websocket answers a status request, and a request to raise the default comes back as an error", integration, async () => {
	const s = scratch(stored("normal"));
	const server = await startBridgeServer({ workspace: s.configHome, permissions: s.options });
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
		const status = await answer("a1", { kind: "permissions", action: "status" });
		assert.equal(status.kind, "permissions");
		if (status.kind === "permissions") assert.equal(status.data.default, "normal");

		const refused = await answer("a2", { kind: "permissions", action: "default", mode: "yolo" });
		assert.equal(refused.kind, "error");
		assert.equal(readFileSync(s.file, "utf8"), stored("normal"), "the refusal must leave the file as it was");

		const unknown = await answer("a3", { kind: "permissions", action: "bogus" });
		assert.equal(unknown.kind, "error", "an action the bridge does not know must be answered");

		const lowered = await answer("a4", { kind: "permissions", action: "default", mode: "auto" });
		assert.equal(lowered.kind, "permissions");
		assert.equal(readFileSync(s.file, "utf8"), stored("auto"));
	} finally {
		ws.close();
		await server.close();
	}
});
