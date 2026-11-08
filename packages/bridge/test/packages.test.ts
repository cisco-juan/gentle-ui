// The first consumer of the write foundation: the packages list in the agent's `settings.json`.
//
// Two things are at stake. The first is that this family never reaches the network: it writes the
// `packages` entry with Pi's own settings writer and leaves the installation of the package itself to
// Pi when the agent starts, so every behaviour test runs against a package manager that can only touch
// the settings it is handed. The second is the confirmation: nothing is written without the digest the
// preview showed, an apply of a plan that was already used fails, a file that changed in between is
// never overwritten, and a settings file Pi cannot read is reported `unavailable` and left alone.
//
// The package manager is faked through the same `loadLibrary` seam `settings` and `permissions` use;
// everywhere else the tests run Pi's real `SettingsManager` and real files in scratch homes under the
// temp directory.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { WebSocket } from "ws";
import type { ServerMessage } from "@gentle-shell/protocol";
import {
	loadPackagesLibrary,
	packagesApply,
	packagesList,
	packagesPreview,
	type PackagesOptions,
} from "../src/packages.ts";
import { startBridgeServer } from "../src/server.ts";

interface Scratch {
	readonly root: string;
	readonly configHome: string;
	readonly agentHome: string;
	readonly workspace: string;
	readonly path: string;
}

const scratchRoots: string[] = [];
after(() => {
	for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

function scratch(): Scratch {
	const root = mkdtempSync(join(tmpdir(), "gentle-packages-"));
	scratchRoots.push(root);
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	const workspace = join(root, "work");
	for (const dir of [configHome, agentHome, workspace]) mkdirSync(dir, { recursive: true });
	return { root, configHome, agentHome, workspace, path: join(agentHome, "settings.json") };
}

function writeSettings(s: Scratch, value: unknown): string {
	writeFileSync(s.path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
	return s.path;
}

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

/** Every source the fake package manager was asked for, so a test can prove what ran and what did not. */
const calls: string[] = [];

type PackageEntry = string | { readonly source: string };

/**
 * A package manager that changes only the settings it is handed.
 *
 * It has no `install`, no `update` and no network of any kind: if this family ever tried to install a
 * package instead of writing the entry, the call would throw and the test would fail loudly.
 */
class FakePackageManager {
	private readonly settings: {
		getGlobalSettings(): { readonly packages?: readonly PackageEntry[] };
		setPackages(packages: PackageEntry[]): void;
	};

	constructor(options: { settingsManager: FakePackageManager["settings"] }) {
		this.settings = options.settingsManager;
	}

	addSourceToSettings(source: string): boolean {
		calls.push(`add:${source}`);
		const current = this.settings.getGlobalSettings().packages ?? [];
		const stringified = current.map((entry) => (typeof entry === "string" ? entry : entry.source));
		if (stringified.includes(source)) return false;
		this.settings.setPackages([...current, source]);
		return true;
	}

	removeSourceFromSettings(source: string): boolean {
		calls.push(`remove:${source}`);
		const current = this.settings.getGlobalSettings().packages ?? [];
		const next = current.filter((entry) => (typeof entry === "string" ? entry : entry.source) !== source);
		if (next.length === current.length) return false;
		this.settings.setPackages(next);
		return true;
	}
}

/** The family's own options, with Pi's library loaded and only its package manager replaced. */
function options(s: Scratch): PackagesOptions {
	return {
		configHome: s.configHome,
		agentHome: s.agentHome,
		loadLibrary: async (root) => ({ ...(await loadPackagesLibrary(root)), DefaultPackageManager: FakePackageManager }),
	};
}

/** One answer per request, whatever the bridge sends in between. */
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

test("the list is what Pi loads from the agent's settings.json, and reading reaches no network", async () => {
	const s = scratch();
	writeSettings(s, {
		defaultProvider: "anthropic",
		packages: ["gentle-plain", { source: "npm:gentle-pi", autoload: false, skills: ["skills"] }],
	});

	// No fake here: the real library, and the only action a real library may be asked for is a read.
	const view = await packagesList(s.workspace, { configHome: s.configHome, agentHome: s.agentHome });

	assert.equal(view.state, "ok");
	assert.equal(view.reason, null);
	assert.equal(view.path, s.path);
	assert.equal(view.stored, true);
	assert.equal(view.plan, null);
	assert.equal(view.change, null);
	assert.equal(view.backup, null);
	assert.deepEqual(view.packages, [
		{ source: "gentle-plain", autoload: true, extensions: [], skills: [], prompts: [], themes: [] },
		{ source: "npm:gentle-pi", autoload: false, extensions: [], skills: ["skills"], prompts: [], themes: [] },
	]);
});

test("with no settings.json the list is empty, says so, and creates nothing", async () => {
	const s = scratch();
	const view = await packagesList(s.workspace, options(s));

	assert.equal(view.state, "ok");
	assert.equal(view.stored, false);
	assert.deepEqual(view.packages, []);
	assert.deepEqual(readdirSync(s.agentHome), [], "listing must not create a settings file");
});

test("a preview shows the plan and its digest, and writes nothing at all", async () => {
	const s = scratch();
	const original = `{\n    "defaultProvider": "anthropic",\n    "packages": ["gentle-plain"]\n}\n`;
	writeSettings(s, original);
	const before = [snapshot(s.agentHome), snapshot(s.configHome)];

	const preview = await packagesPreview(s.workspace, "install", "npm:gentle-pi", options(s));

	assert.equal(preview.state, "ok");
	assert.equal(preview.reason, null);
	assert.notEqual(preview.plan, null);
	assert.equal(preview.plan?.operation, "packages.install");
	assert.equal(preview.plan?.target, s.path);
	assert.match(preview.plan?.digest ?? "", /^[0-9a-f]{64}$/);
	assert.equal(preview.plan?.summary.some((line) => line.includes("npm:gentle-pi")), true);
	assert.deepEqual(preview.packages.map((entry) => entry.source), ["gentle-plain"], "the file on disk is unchanged");
	assert.deepEqual(preview.change?.before.map((entry) => entry.source), ["gentle-plain"]);
	assert.deepEqual(preview.change?.after.map((entry) => entry.source), ["gentle-plain", "npm:gentle-pi"]);
	assert.equal(preview.backup, null);

	assert.deepEqual([snapshot(s.agentHome), snapshot(s.configHome)], before, "a preview writes nothing in either home");

	// One plan, one digest: asking twice cannot change what the confirmation would show.
	const again = await packagesPreview(s.workspace, "install", "npm:gentle-pi", options(s));
	assert.equal(again.plan?.digest, preview.plan?.digest);
});

test("an apply with the confirmed digest writes the entry, keeps the other keys and backs the old file up", async () => {
	const s = scratch();
	const original = `{\n    "defaultProvider": "anthropic",\n    "packages": ["gentle-plain"]\n}\n`;
	writeSettings(s, original);
	calls.length = 0;

	const preview = await packagesPreview(s.workspace, "install", "npm:gentle-pi", options(s));
	const applied = await packagesApply(s.workspace, "install", "npm:gentle-pi", preview.plan?.digest, options(s));

	assert.equal(applied.state, "ok");
	assert.equal(applied.reason, null);
	assert.deepEqual([...new Set(calls)], ["add:npm:gentle-pi"], "only the settings entry was written; nothing was installed");
	assert.deepEqual(readdirSync(s.agentHome).sort(), ["settings.json"]);

	const written = readFileSync(s.path, "utf8");
	const parsed = JSON.parse(written) as { defaultProvider: string; packages: string[] };
	assert.equal(parsed.defaultProvider, "anthropic", "a key this family does not own is kept as it was");
	assert.deepEqual(parsed.packages, ["gentle-plain", "npm:gentle-pi"]);
	assert.match(written, /\n {4}"defaultProvider"/, "the file's own indentation is kept");
	assert.ok(written.endsWith("\n"), "the file's final newline is kept");
	assert.equal(statSync(s.path).mode & 0o777, 0o600);
	assert.deepEqual(applied.packages.map((entry) => entry.source), ["gentle-plain", "npm:gentle-pi"]);
	assert.deepEqual(applied.change?.before.map((entry) => entry.source), ["gentle-plain"]);

	// The previous bytes are kept, and the answer says where.
	const backups = readdirSync(join(s.configHome, "packages-backups"));
	assert.equal(backups.length, 1);
	assert.match(backups[0] ?? "", /^settings\..+\.json$/);
	assert.equal(applied.backup, join(s.configHome, "packages-backups", backups[0] ?? ""));
	assert.equal(readFileSync(applied.backup ?? "", "utf8"), original);
});

test("an apply without the digest the confirmation showed is refused and nothing is written", async () => {
	const s = scratch();
	const original = `{\n  "packages": []\n}\n`;
	writeSettings(s, original);
	await packagesPreview(s.workspace, "install", "npm:gentle-pi", options(s));

	for (const digest of [undefined, "", "   "]) {
		await assert.rejects(() => packagesApply(s.workspace, "install", "npm:gentle-pi", digest, options(s)), /digest/);
		assert.equal(readFileSync(s.path, "utf8"), original);
	}
	assert.deepEqual(readdirSync(s.agentHome), ["settings.json"]);
});

test("an apply whose digest does not match the recomputed plan is refused as a stale plan", async () => {
	const s = scratch();
	const original = `{\n  "packages": []\n}\n`;
	writeSettings(s, original);
	const preview = await packagesPreview(s.workspace, "install", "npm:gentle-pi", options(s));

	const other = await packagesApply(s.workspace, "install", "npm:other", preview.plan?.digest, options(s));
	assert.equal(other.state, "refused");
	assert.equal(other.reason, "stale-plan");
	assert.match(other.message, /preview again/i);
	assert.equal(readFileSync(s.path, "utf8"), original);
});

test("an apply after the file changed on disk is refused and the newer content is left untouched", async () => {
	const s = scratch();
	writeSettings(s, `{\n  "packages": []\n}\n`);
	const preview = await packagesPreview(s.workspace, "install", "npm:gentle-pi", options(s));

	const changed = `{\n  "packages": ["npm:from-the-terminal"]\n}\n`;
	writeSettings(s, changed);

	const refused = await packagesApply(s.workspace, "install", "npm:gentle-pi", preview.plan?.digest, options(s));
	assert.equal(refused.state, "refused");
	assert.equal(refused.reason, "changed-on-disk");
	assert.equal(readFileSync(s.path, "utf8"), changed, "the newest content wins");
});

test("the same digest cannot be applied twice, and the first result stays", async () => {
	const s = scratch();
	writeSettings(s, `{\n  "packages": []\n}\n`);
	const preview = await packagesPreview(s.workspace, "install", "npm:gentle-pi", options(s));

	const first = await packagesApply(s.workspace, "install", "npm:gentle-pi", preview.plan?.digest, options(s));
	assert.equal(first.state, "ok");
	const afterFirst = readFileSync(s.path, "utf8");

	const second = await packagesApply(s.workspace, "install", "npm:gentle-pi", preview.plan?.digest, options(s));
	assert.equal(second.state, "refused");
	assert.equal(second.reason, "stale-plan");
	assert.equal(readFileSync(s.path, "utf8"), afterFirst);
});

test("a remove takes the source out of packages and keeps a backup of what was there", async () => {
	const s = scratch();
	const original = `{\n  "packages": ["gentle-plain", "npm:gentle-pi"]\n}\n`;
	writeSettings(s, original);
	calls.length = 0;

	const preview = await packagesPreview(s.workspace, "remove", "npm:gentle-pi", options(s));
	assert.deepEqual(preview.packages.map((entry) => entry.source), ["gentle-plain", "npm:gentle-pi"]);
	assert.deepEqual(preview.change?.after.map((entry) => entry.source), ["gentle-plain"]);

	const applied = await packagesApply(s.workspace, "remove", "npm:gentle-pi", preview.plan?.digest, options(s));
	assert.equal(applied.state, "ok");
	assert.deepEqual([...new Set(calls)], ["remove:npm:gentle-pi"], "only the settings entry was removed; nothing was installed or uninstalled");
	assert.deepEqual(applied.packages.map((entry) => entry.source), ["gentle-plain"]);
	assert.deepEqual((JSON.parse(readFileSync(s.path, "utf8")) as { packages: string[] }).packages, ["gentle-plain"]);
	assert.equal(readFileSync(applied.backup ?? "", "utf8"), original);
});

test("removing something that is not listed is refused with a message, and nothing is written", async () => {
	const s = scratch();
	const original = `{\n  "packages": ["gentle-plain"]\n}\n`;
	writeSettings(s, original);

	await assert.rejects(() => packagesPreview(s.workspace, "remove", "npm:absent", options(s)), /does not list/);
	await assert.rejects(() => packagesPreview(s.workspace, "install", "gentle-plain", options(s)), /already lists/);
	assert.equal(readFileSync(s.path, "utf8"), original);
});

test("a settings.json Pi cannot read is unavailable in every action, and is never replaced", async () => {
	for (const text of ["{not json", "[]", "null", '"settings"']) {
		const s = scratch();
		writeSettings(s, text);

		const list = await packagesList(s.workspace, options(s));
		assert.equal(list.state, "unavailable", text);
		assert.equal(list.reason, "file-invalid", text);
		assert.match(list.message, /settings\.json/, text);
		assert.deepEqual(list.packages, [], "a broken file must not read as an empty package list");

		const preview = await packagesPreview(s.workspace, "install", "npm:gentle-pi", options(s));
		assert.equal(preview.state, "unavailable", text);
		assert.equal(preview.reason, "file-invalid", text);
		assert.equal(preview.plan, null, "there is no plan to confirm for a file that cannot be read");

		// Even a digest of the right shape cannot get past an unavailable file.
		const applied = await packagesApply(s.workspace, "install", "npm:gentle-pi", "0".repeat(64), options(s));
		assert.equal(applied.state, "unavailable", text);
		assert.equal(applied.reason, "file-invalid", text);

		assert.equal(readFileSync(s.path, "utf8"), text, "the broken file is left exactly as it was");
	}
});

test("an operation the bridge does not know, and a source that is not a string, are refused", async () => {
	const s = scratch();
	writeSettings(s, `{\n  "packages": []\n}\n`);

	for (const operation of ["update", "INSTALL", "", 3, null]) {
		await assert.rejects(() => packagesPreview(s.workspace, operation, "npm:x", options(s)), /install|remove/);
	}
	for (const source of ["", "   ", 3, null]) {
		await assert.rejects(() => packagesPreview(s.workspace, "install", source, options(s)), /source/);
	}
	assert.equal(readFileSync(s.path, "utf8"), `{\n  "packages": []\n}\n`);
});

test("the websocket answers list, preview and apply, and an action it does not know comes back as an error", async () => {
	const s = scratch();
	writeSettings(s, { defaultProvider: "anthropic", packages: ["gentle-plain"] });
	const server = await startBridgeServer({ workspace: s.workspace, packages: options(s) });
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	const answer = async (id: string, request: Record<string, unknown>): Promise<ServerMessage> => {
		const waiting = next(ws, (message) => "id" in message && message.id === id);
		ws.send(JSON.stringify({ id, ...request }));
		return await waiting;
	};
	try {
		await new Promise((resolve) => ws.on("open", resolve));

		const listed = await answer("p1", { kind: "packages", action: "list" });
		assert.equal(listed.kind, "packages");
		if (listed.kind === "packages") {
			assert.equal(listed.action, "list");
			assert.deepEqual(listed.data.packages.map((entry) => entry.source), ["gentle-plain"]);
		}

		const preview = await answer("p2", { kind: "packages", action: "preview", operation: "install", source: "npm:gentle-pi" });
		assert.equal(preview.kind, "packages");
		const digest = preview.kind === "packages" ? (preview.data.plan?.digest ?? "") : "";
		assert.match(digest, /^[0-9a-f]{64}$/);

		const applied = await answer("p3", {
			kind: "packages",
			action: "apply",
			operation: "install",
			source: "npm:gentle-pi",
			digest,
		});
		assert.equal(applied.kind, "packages");
		if (applied.kind === "packages") {
			assert.equal(applied.action, "apply");
			assert.equal(applied.data.state, "ok");
			assert.deepEqual(applied.data.packages.map((entry) => entry.source), ["gentle-plain", "npm:gentle-pi"]);
			assert.notEqual(applied.data.backup, null);
		}

		const unknown = await answer("p4", { kind: "packages", action: "update" });
		assert.equal(unknown.kind, "error", "an action the bridge does not know must be answered");
	} finally {
		ws.close();
		await server.close();
	}
});
