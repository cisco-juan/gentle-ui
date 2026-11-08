// Setting one of the bounded keys of the agent's `settings.json`, behind a confirmed plan.
//
// This family is not a JSON editor. The keys it may touch are exactly the ones the read view already
// reports — `defaultProvider`, `defaultModel`, `defaultThinkingLevel` — and every value is checked
// before a plan exists, so an unknown key or a value Pi would not accept is refused with a readable
// reason instead of being written. The write itself is `config-write.ts`'s: the digest of the plan the
// confirmation shows, a single-use plan, a backup of the bytes it replaces, and an atomic `0600` write.
// A file that changed underneath, or one that cannot be parsed, is never replaced.
//
// Every test works in a scratch agent home, config home and workspace under the temp directory; the
// files are real and nothing on the filesystem is mocked. The only stand-in is Pi's library, injected
// through the same `loadLibrary` seam the other families use, and only in the two tests that prove a
// library failure is reported by name and that the accepted thinking levels are Pi's own decision.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { WebSocket } from "ws";
import type { ServerMessage } from "@gentle-shell/protocol";
import {
	loadSettingsWriteLibrary,
	settingsWriteApply,
	settingsWritePreview,
	type SettingsWriteOptions,
} from "../src/settings-write.ts";
import { startBridgeServer } from "../src/server.ts";

interface Scratch {
	readonly root: string;
	readonly configHome: string;
	readonly agentHome: string;
	readonly workspace: string;
	readonly path: string;
	readonly options: SettingsWriteOptions;
}

/** Every scratch folder this file made, removed once the file's tests are done. */
const scratchRoots: string[] = [];
after(() => {
	for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/** A config home, an agent home and a workspace, all empty and all inside the temp directory. */
function scratch(): Scratch {
	const root = mkdtempSync(join(tmpdir(), "gentle-settings-write-"));
	scratchRoots.push(root);
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	const workspace = join(root, "work");
	for (const dir of [configHome, agentHome, workspace]) mkdirSync(dir, { recursive: true });
	return {
		root,
		configHome,
		agentHome,
		workspace,
		path: join(agentHome, "settings.json"),
		options: { configHome, agentHome },
	};
}

/** Write `<agentHome>/settings.json` from an object, or verbatim when the text is deliberately broken. */
function writeSettings(s: Scratch, value: unknown): string {
	writeFileSync(s.path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
	return s.path;
}

/** Every file under `dir` with its bytes, so "a preview wrote nothing" is a comparison, not a claim. */
function snapshot(dir: string): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				files.set(`${relative(dir, path)}/`, "");
				walk(path);
			} else {
				files.set(relative(dir, path), readFileSync(path, "utf8"));
			}
		}
	};
	walk(dir);
	return files;
}

function keysOf(view: { readonly keys: readonly { readonly key: string; readonly value: unknown }[] }): Record<string, unknown> {
	return Object.fromEntries(view.keys.map((entry) => [entry.key, entry.value]));
}

// ---- preview ----

test("a preview shows the plan and its digest, and writes nothing at all", async () => {
	const s = scratch();
	const original = `{\n    "defaultProvider": "anthropic",\n    "defaultModel": "claude-opus-5-5"\n}\n`;
	writeSettings(s, original);
	const before = [snapshot(s.agentHome), snapshot(s.configHome)];

	const preview = await settingsWritePreview(s.workspace, { key: "defaultModel", value: "claude-sonnet-5-5" }, s.options);

	assert.equal(preview.state, "ok");
	assert.equal(preview.reason, null);
	assert.equal(preview.path, s.path);
	assert.equal(preview.stored, true);
	assert.notEqual(preview.plan, null);
	assert.equal(preview.plan?.operation, "settings.set");
	assert.equal(preview.plan?.target, s.path);
	assert.match(preview.plan?.digest ?? "", /^[0-9a-f]{64}$/);
	assert.equal(preview.plan?.summary.some((line) => line.includes("defaultModel")), true);
	assert.deepEqual(preview.change, { key: "defaultModel", before: "claude-opus-5-5", after: "claude-sonnet-5-5" });
	assert.deepEqual(keysOf(preview), {
		defaultProvider: "anthropic",
		defaultModel: "claude-opus-5-5",
		defaultThinkingLevel: null,
	});
	assert.equal(preview.backup, null);

	assert.deepEqual([snapshot(s.agentHome), snapshot(s.configHome)], before, "a preview writes nothing in either home");

	// One plan, one digest: asking twice cannot change what the confirmation would show.
	const again = await settingsWritePreview(s.workspace, { key: "defaultModel", value: "claude-sonnet-5-5" }, s.options);
	assert.equal(again.plan?.digest, preview.plan?.digest);
});

// ---- apply ----

test("an apply with the confirmed digest writes the key and keeps every other key, its order and the file's shape", async () => {
	const s = scratch();
	const original = `{\n    "defaultProvider": "anthropic",\n    "defaultModel": "claude-opus-5-5",\n    "theme": "dark",\n    "defaultThinkingLevel": "medium",\n    "packages": ["gentle-plain"]\n}\n`;
	writeSettings(s, original);

	const preview = await settingsWritePreview(s.workspace, { key: "defaultModel", value: "claude-sonnet-5-5" }, s.options);
	const applied = await settingsWriteApply(s.workspace, { key: "defaultModel", value: "claude-sonnet-5-5" }, preview.plan?.digest, s.options);

	assert.equal(applied.state, "ok");
	assert.equal(applied.reason, null);
	assert.deepEqual(readdirSync(s.agentHome).sort(), ["settings.json"], "the write leaves no other file in the agent home");

	const written = readFileSync(s.path, "utf8");
	const parsed = JSON.parse(written) as Record<string, unknown>;
	assert.equal(parsed["defaultModel"], "claude-sonnet-5-5", "the named key is the one that changed");
	assert.equal(parsed["defaultProvider"], "anthropic", "a key this family does not write is kept as it was");
	assert.equal(parsed["theme"], "dark", "a key outside the writable set is kept as it was");
	assert.equal(parsed["defaultThinkingLevel"], "medium", "a sibling key is kept as it was");
	assert.deepEqual(parsed["packages"], ["gentle-plain"], "another family's key is kept as it was");

	// Order is the file's, not this family's: the edited key stays where it was.
	const order = ['"defaultProvider"', '"defaultModel"', '"theme"', '"defaultThinkingLevel"', '"packages"'].map((key) =>
		written.indexOf(key),
	);
	assert.deepEqual([...order].sort((left, right) => left - right), order, "the keys keep the order the file had");
	assert.match(written, /\n {4}"defaultProvider"/, "the file's own indentation is kept");
	assert.ok(written.endsWith("\n"), "the file's final newline is kept");
	assert.equal(statSync(s.path).mode & 0o777, 0o600);

	assert.deepEqual(keysOf(applied), {
		defaultProvider: "anthropic",
		defaultModel: "claude-sonnet-5-5",
		defaultThinkingLevel: "medium",
	});

	// The previous bytes are kept where C3 says, and the answer says where.
	const backups = readdirSync(join(s.configHome, "settings-backups"));
	assert.equal(backups.length, 1);
	assert.match(backups[0] ?? "", /^settings\..+\.json$/);
	assert.equal(applied.backup, join(s.configHome, "settings-backups", backups[0] ?? ""));
	assert.equal(readFileSync(applied.backup ?? "", "utf8"), original);
	assert.equal(applied.notes.some((note) => note.includes("kept at")), true);
});

test("a file indented with tabs keeps its tabs", async () => {
	const s = scratch();
	writeSettings(s, `{\n\t"defaultProvider": "anthropic",\n\t"defaultModel": "claude-opus-5-5"\n}\n`);

	const preview = await settingsWritePreview(s.workspace, { key: "defaultProvider", value: "openai" }, s.options);
	const applied = await settingsWriteApply(s.workspace, { key: "defaultProvider", value: "openai" }, preview.plan?.digest, s.options);

	assert.equal(applied.state, "ok");
	assert.match(readFileSync(s.path, "utf8"), /\n\t"defaultProvider": "openai"/);
});

test("an apply without the digest the confirmation showed is refused and nothing is written", async () => {
	const s = scratch();
	const original = `{\n  "defaultProvider": "anthropic"\n}\n`;
	writeSettings(s, original);
	await settingsWritePreview(s.workspace, { key: "defaultProvider", value: "openai" }, s.options);

	for (const digest of [undefined, "", "   ", 3, null]) {
		await assert.rejects(
			() => settingsWriteApply(s.workspace, { key: "defaultProvider", value: "openai" }, digest, s.options),
			/digest/,
		);
		assert.equal(readFileSync(s.path, "utf8"), original);
	}
});

test("an apply whose digest does not describe this request is refused as a stale plan", async () => {
	const s = scratch();
	const original = `{\n  "defaultProvider": "anthropic"\n}\n`;
	writeSettings(s, original);
	const preview = await settingsWritePreview(s.workspace, { key: "defaultProvider", value: "openai" }, s.options);

	const refused = await settingsWriteApply(s.workspace, { key: "defaultProvider", value: "google" }, preview.plan?.digest, s.options);
	assert.equal(refused.state, "refused");
	assert.equal(refused.reason, "stale-plan");
	assert.match(refused.message, /preview again/i);
	assert.equal(refused.plan, null);
	assert.equal(refused.change, null);
	assert.equal(refused.backup, null);
	assert.equal(readFileSync(s.path, "utf8"), original);
});

test("the same digest cannot be applied twice, and the first result stays", async () => {
	const s = scratch();
	writeSettings(s, `{\n  "defaultProvider": "anthropic"\n}\n`);
	const preview = await settingsWritePreview(s.workspace, { key: "defaultProvider", value: "openai" }, s.options);

	const first = await settingsWriteApply(s.workspace, { key: "defaultProvider", value: "openai" }, preview.plan?.digest, s.options);
	assert.equal(first.state, "ok");
	const afterFirst = readFileSync(s.path, "utf8");

	const second = await settingsWriteApply(s.workspace, { key: "defaultProvider", value: "openai" }, preview.plan?.digest, s.options);
	assert.equal(second.state, "refused");
	assert.equal(second.reason, "stale-plan");
	assert.equal(readFileSync(s.path, "utf8"), afterFirst);
});

test("an apply after the file changed on disk is refused and the newer content is left untouched", async () => {
	const s = scratch();
	writeSettings(s, `{\n  "defaultProvider": "anthropic"\n}\n`);
	const preview = await settingsWritePreview(s.workspace, { key: "defaultProvider", value: "openai" }, s.options);

	const changed = `{\n  "defaultProvider": "from-the-terminal"\n}\n`;
	writeSettings(s, changed);

	const refused = await settingsWriteApply(s.workspace, { key: "defaultProvider", value: "openai" }, preview.plan?.digest, s.options);
	assert.equal(refused.state, "refused");
	assert.equal(refused.reason, "changed-on-disk");
	assert.equal(readFileSync(s.path, "utf8"), changed, "the newest content wins");
});

test("a settings.json that is not one Pi reads is unavailable in every action, and is never replaced", async () => {
	for (const text of ["{not json", "[]", "null", '"settings"', ""]) {
		const s = scratch();
		writeSettings(s, text);

		const preview = await settingsWritePreview(s.workspace, { key: "defaultProvider", value: "openai" }, s.options);
		assert.equal(preview.state, "unavailable", text);
		assert.equal(preview.reason, "file-invalid", text);
		assert.match(preview.message, /settings\.json/, text);
		assert.equal(preview.plan, null, "there is no plan to confirm for a file that cannot be read");
		assert.deepEqual(preview.keys, [], "a broken file must not read as a set of unset keys");

		// Even a digest of the right shape cannot get past an unavailable file.
		const applied = await settingsWriteApply(s.workspace, { key: "defaultProvider", value: "openai" }, "0".repeat(64), s.options);
		assert.equal(applied.state, "unavailable", text);
		assert.equal(applied.reason, "file-invalid", text);

		assert.equal(readFileSync(s.path, "utf8"), text, "the broken file is left exactly as it was");
	}
});

test("with no settings.json yet, a preview creates nothing and an apply writes just that key", async () => {
	const s = scratch();

	const preview = await settingsWritePreview(s.workspace, { key: "defaultModel", value: "claude-sonnet-5-5" }, s.options);
	assert.equal(preview.state, "ok");
	assert.equal(preview.stored, false);
	assert.deepEqual(keysOf(preview), { defaultProvider: null, defaultModel: null, defaultThinkingLevel: null });
	assert.deepEqual(readdirSync(s.agentHome), [], "a preview of a missing file creates nothing");

	const applied = await settingsWriteApply(s.workspace, { key: "defaultModel", value: "claude-sonnet-5-5" }, preview.plan?.digest, s.options);
	assert.equal(applied.state, "ok");
	assert.deepEqual(JSON.parse(readFileSync(s.path, "utf8")), { defaultModel: "claude-sonnet-5-5" });
	assert.ok(readFileSync(s.path, "utf8").endsWith("\n"));
	assert.equal(statSync(s.path).mode & 0o777, 0o600);
	assert.equal(applied.backup, null, "there was nothing to keep");
	assert.equal(applied.stored, true);
});

test("setting a key to the value it already holds is refused, and nothing is written", async () => {
	const s = scratch();
	const original = `{\n  "defaultProvider": "anthropic"\n}\n`;
	writeSettings(s, original);

	await assert.rejects(
		() => settingsWritePreview(s.workspace, { key: "defaultProvider", value: "anthropic" }, s.options),
		/already sets/,
	);
	assert.equal(readFileSync(s.path, "utf8"), original);
});

// ---- the bounded key set ----

test("a key outside the writable set is refused with the keys this can write", async () => {
	const s = scratch();
	const original = `{\n  "defaultProvider": "anthropic",\n  "theme": "dark"\n}\n`;
	writeSettings(s, original);

	for (const key of ["theme", "packages", "extensions", "defaultProvider ", "DEFAULTMODEL", "", 3, null, {}]) {
		const refused = settingsWritePreview(s.workspace, { key, value: "x" }, s.options);
		await assert.rejects(() => refused, (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			assert.match(message, /defaultProvider, defaultModel, defaultThinkingLevel/, `${String(key)}: ${message}`);
			return true;
		});
	}
	assert.equal(readFileSync(s.path, "utf8"), original);
});

test("a value that is not a non-empty string is refused for the provider and the model", async () => {
	const s = scratch();
	const original = `{\n  "defaultProvider": "anthropic"\n}\n`;
	writeSettings(s, original);

	for (const key of ["defaultProvider", "defaultModel"]) {
		for (const value of ["", "   ", 3, null, true, {}, []]) {
			await assert.rejects(
				() => settingsWritePreview(s.workspace, { key, value }, s.options),
				(error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					assert.match(message, /non-empty string/, `${key}=${JSON.stringify(value)}: ${message}`);
					return true;
				},
			);
		}
	}
	assert.equal(readFileSync(s.path, "utf8"), original);
});

test("the thinking level accepts exactly the values Pi's own validator accepts", async () => {
	const s = scratch();
	writeSettings(s, `{\n  "defaultProvider": "anthropic"\n}\n`);

	// Pi 1.5.0's `isValidThinkingLevel`: off, minimal, low, medium, high, xhigh, max.
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		const preview = await settingsWritePreview(s.workspace, { key: "defaultThinkingLevel", value: level }, s.options);
		assert.equal(preview.state, "ok", level);
		assert.notEqual(preview.plan, null, level);
	}

	for (const level of ["none", "HIGH", "High", "high ", "very", "", 0, null]) {
		await assert.rejects(
			() => settingsWritePreview(s.workspace, { key: "defaultThinkingLevel", value: level }, s.options),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				assert.match(message, /not a thinking level/, `${JSON.stringify(level)}: ${message}`);
				return true;
			},
		);
	}

	// A level Pi accepts is written; a level it does not is refused with a reason, never written.
	const preview = await settingsWritePreview(s.workspace, { key: "defaultThinkingLevel", value: "xhigh" }, s.options);
	const applied = await settingsWriteApply(s.workspace, { key: "defaultThinkingLevel", value: "xhigh" }, preview.plan?.digest, s.options);
	assert.equal(applied.state, "ok");
	assert.equal((JSON.parse(readFileSync(s.path, "utf8")) as Record<string, unknown>)["defaultThinkingLevel"], "xhigh");
});

test("the accepted thinking levels are Pi's decision, not a list kept here", async () => {
	const s = scratch();
	writeSettings(s, `{\n  "defaultThinkingLevel": "medium"\n}\n`);

	// A Pi whose validator accepts a level no list in this repository knows about.
	const fake = {
		...s.options,
		loadLibrary: async (root: string) => ({
			...(await loadSettingsWriteLibrary(root)),
			isValidThinkingLevel: (level: string) => level === "ultra",
		}),
	};

	const accepted = await settingsWritePreview(s.workspace, { key: "defaultThinkingLevel", value: "ultra" }, fake);
	assert.equal(accepted.state, "ok", "the value is accepted because Pi's validator accepts it");
	assert.notEqual(accepted.plan, null);

	const refused = settingsWritePreview(s.workspace, { key: "defaultThinkingLevel", value: "high" }, fake);
	await assert.rejects(() => refused, /not a thinking level/);
});

test("a library that does not offer what this module calls is unavailable with a reason", async () => {
	const s = scratch();
	writeSettings(s, `{\n  "defaultProvider": "anthropic"\n}\n`);

	const options: SettingsWriteOptions = {
		...s.options,
		loadLibrary: async () => ({ isValidThinkingLevel: () => true }),
	};
	const view = await settingsWritePreview(s.workspace, { key: "defaultProvider", value: "openai" }, options);
	assert.equal(view.state, "unavailable");
	assert.equal(view.reason, "library-incompatible");
	assert.match(view.message, /FileSettingsStorage/);
	assert.equal(view.plan, null);
	assert.equal(readFileSync(s.path, "utf8"), `{\n  "defaultProvider": "anthropic"\n}\n`);
});

// ---- the wire ----

test("the websocket answers read, preview and apply through one family, and an unknown action is an error", async () => {
	const s = scratch();
	writeSettings(s, { defaultProvider: "anthropic", defaultThinkingLevel: "medium" });
	const server = await startBridgeServer({ workspace: s.workspace, settings: s.options, settingsWrite: s.options });
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	const answer = async (id: string, request: Record<string, unknown>): Promise<ServerMessage> => {
		const waiting = new Promise<ServerMessage>((resolve) => {
			ws.on("message", function onMessage(raw: { toString(): string }): void {
				const message = JSON.parse(raw.toString()) as ServerMessage;
				if ("id" in message && message.id === id) {
					ws.off("message", onMessage);
					resolve(message);
				}
			});
		});
		ws.send(JSON.stringify({ id, ...request }));
		return await waiting;
	};
	try {
		await new Promise((resolve) => ws.on("open", resolve));

		const read = await answer("w1", { kind: "settings", action: "read" });
		assert.equal(read.kind, "settings");
		if (read.kind === "settings") {
			assert.equal(read.action, "read");
			assert.equal(read.data.settings.stored, true);
		}

		const preview = await answer("w2", { kind: "settings", action: "preview", key: "defaultProvider", value: "openai" });
		assert.equal(preview.kind, "settings");
		const digest = preview.kind === "settings" && preview.action === "preview" ? (preview.data.plan?.digest ?? "") : "";
		assert.match(digest, /^[0-9a-f]{64}$/);

		const applied = await answer("w3", { kind: "settings", action: "apply", key: "defaultProvider", value: "openai", digest });
		assert.equal(applied.kind, "settings");
		if (applied.kind === "settings" && applied.action === "apply") {
			assert.equal(applied.data.state, "ok");
			assert.equal((JSON.parse(readFileSync(s.path, "utf8")) as Record<string, unknown>)["defaultProvider"], "openai");
			assert.equal((JSON.parse(readFileSync(s.path, "utf8")) as Record<string, unknown>)["defaultThinkingLevel"], "medium");
			assert.notEqual(applied.data.backup, null);
		}

		const unknown = await answer("w4", { kind: "settings", action: "write" });
		assert.equal(unknown.kind, "error", "an action the bridge does not know must be answered");
	} finally {
		ws.close();
		await server.close();
	}
});
