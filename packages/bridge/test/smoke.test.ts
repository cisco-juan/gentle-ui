import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProcess } from "../src/pi-process.ts";
import { resolveCommand } from "../src/commands.ts";

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "gentle-bridge-"));
}

test("forwards a command and resolves with its response data", async () => {
	const pi = new PiProcess({ cwd: workspace() });
	pi.start();
	try {
		const state = await pi.send<Record<string, unknown>>("get_state");
		assert.equal(typeof state, "object");
		assert.notEqual(state, null);
	} finally {
		await pi.stop();
	}
});

test("returns the command list Pi advertises", async () => {
	const pi = new PiProcess({ cwd: workspace() });
	pi.start();
	try {
		const { commands } = await pi.send<{ commands: Array<{ name: string; description: string }> }>("get_commands");
		assert.ok(Array.isArray(commands));
		assert.ok(commands.length > 0);
		for (const command of commands) {
			assert.equal(typeof command.name, "string");
			assert.equal(typeof command.description, "string");
		}
	} finally {
		await pi.stop();
	}
});

test("rejects an unknown command without touching the agent", () => {
	assert.throws(() => resolveCommand("drop_database"), /unsupported command: drop_database/);
	assert.equal(resolveCommand("get_state"), "get_state");
});

test("a stopped process fails fast instead of hanging", async () => {
	const pi = new PiProcess({ cwd: workspace() });
	pi.start();
	await pi.stop();
	await assert.rejects(() => pi.send("get_state"), /not running/);
});
