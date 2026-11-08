// The read-only settings view: what the agent the bridge launches is configured with.
//
// Two things are at stake here, and neither is cosmetic. The first is *which* configuration is read:
// the bridge pins PI_CODING_AGENT_DIR to `~/.gentle-shell/agent`, so that folder is the agent's own
// config and `~/.pi/agent` is not. The second is redaction: this view is a read of files that hold
// MCP credentials, and no header, environment value, OAuth secret or token in a URL may reach the
// answer, a log or an error message — those render as `<redacted>`.
//
// Every test works in a scratch agent home, config home and workspace under the temp directory; files
// are real and nothing is mocked. Reading is also proven to write nothing at all.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { WebSocket } from "ws";
import type { ServerMessage, SettingsView } from "@gentle-shell/protocol";
import { settingsRead, type SettingsOptions } from "../src/settings.ts";
import { startBridgeServer } from "../src/server.ts";

interface Scratch {
	readonly root: string;
	readonly configHome: string;
	readonly agentHome: string;
	readonly workspace: string;
	readonly options: SettingsOptions;
}

/** Every scratch folder this file made, removed once the file's tests are done. */
const scratchRoots: string[] = [];
after(() => {
	for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/** A config home, an agent home and a workspace, all empty and all inside the temp directory. */
function scratch(): Scratch {
	const root = mkdtempSync(join(tmpdir(), "gentle-settings-"));
	scratchRoots.push(root);
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	const workspace = join(root, "work");
	for (const dir of [configHome, agentHome, workspace]) mkdirSync(dir, { recursive: true });
	return { root, configHome, agentHome, workspace, options: { configHome, agentHome } };
}

/** Write `<agentHome>/settings.json`, from an object or from text when the text is deliberately broken. */
function writeSettings(s: Scratch, value: unknown): string {
	const path = join(s.agentHome, "settings.json");
	writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
	return path;
}

function writeMcp(s: Scratch, value: unknown): string {
	const path = join(s.agentHome, "mcp.json");
	writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
	return path;
}

/** A skill folder of the shape Pi discovers: a `SKILL.md` with a name and a description. */
function skill(dir: string, name: string, description: string): string {
	const path = join(dir, name);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`);
	return join(path, "SKILL.md");
}

/** Every file under `dir` with its bytes, so "reading wrote nothing" is a comparison, not a claim. */
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

/** Any of `secrets` that the answer carries, in any field, at any depth. */
function leaked(view: SettingsView, secrets: readonly string[]): string[] {
	const text = JSON.stringify(view);
	return secrets.filter((secret) => text.includes(secret));
}

function keysOf(view: SettingsView): Record<string, unknown> {
	return Object.fromEntries(view.settings.keys.map((entry) => [entry.key, entry.value]));
}

test("the two homes are the ones the bridge launches Pi with, never Pi's own config folder", async () => {
	const s = scratch();
	// A home of its own, so the defaults are exercised instead of this machine's real folders.
	const view = await settingsRead(s.workspace, { home: s.root });
	assert.equal(view.agentHome, join(s.root, ".gentle-shell", "agent"));
	assert.equal(view.configHome, join(s.root, ".gentle-shell", "gentle-ai"));
	assert.ok(!view.agentHome.includes(`${join(s.root, ".pi")}`), "the agent home must not be Pi's own folder");
	assert.ok(!view.configHome.includes(`${join(s.root, ".pi")}`), "the config home must not be Pi's own folder");
});

test("a library Pi's own code does not offer is unavailable with a reason, not an empty view", async () => {
	const s = scratch();
	const view = await settingsRead(s.workspace, { ...s.options, loadLibrary: async () => ({}) });
	assert.equal(view.state, "unavailable");
	assert.equal(view.reason, "library-incompatible");
	assert.match(view.message, /loadSkills/);
	assert.deepEqual(view.settings.packages, []);
	assert.deepEqual(view.skills.entries, []);
	assert.deepEqual(view.mcp.servers, []);
});

test("reports the packages and the model keys stored in settings.json", async () => {
	const s = scratch();
	writeSettings(s, {
		defaultProvider: "anthropic",
		defaultModel: "claude-opus-5-5",
		defaultThinkingLevel: "high",
		// A key this view does not show is left where it is, and is not reported.
		theme: "gentle-dark",
		packages: ["gentle-plain", { source: "gentle-pi", autoload: false, skills: ["skills"], prompts: [] }],
	});
	const view = await settingsRead(s.workspace, s.options);
	assert.equal(view.state, "ok");
	assert.equal(view.settings.state, "ok");
	assert.equal(view.settings.stored, true);
	assert.equal(view.settings.path, join(s.agentHome, "settings.json"));
	assert.deepEqual(keysOf(view), {
		defaultProvider: "anthropic",
		defaultModel: "claude-opus-5-5",
		defaultThinkingLevel: "high",
	});
	assert.deepEqual(view.settings.packages, [
		{ source: "gentle-plain", autoload: true, extensions: [], skills: [], prompts: [], themes: [] },
		{ source: "gentle-pi", autoload: false, extensions: [], skills: ["skills"], prompts: [], themes: [] },
	]);
});

test("with no settings.json the keys are unset, the view says the file is not stored, and nothing is created", async () => {
	const s = scratch();
	const view = await settingsRead(s.workspace, s.options);
	assert.equal(view.state, "ok");
	assert.equal(view.settings.stored, false);
	assert.deepEqual(keysOf(view), { defaultProvider: null, defaultModel: null, defaultThinkingLevel: null });
	assert.deepEqual(view.settings.packages, []);
	assert.deepEqual(readdirSync(s.agentHome), [], "asking for the view must not create a settings file");
});

test("reports the skills on disk with the scope Pi gives them", async () => {
	const s = scratch();
	// A global skill, a project skill and one from a path settings.json names.
	skill(join(s.agentHome, "skills"), "global-skill", "One the agent home provides.");
	skill(join(s.workspace, ".pi", "skills"), "project-skill", "One this repository provides.");
	const extra = join(s.root, "extra-skills");
	skill(extra, "extra-skill", "One settings.json names by path.");
	writeSettings(s, { skills: [extra] });

	const view = await settingsRead(s.workspace, s.options);
	assert.equal(view.skills.state, "ok");
	assert.equal(view.skills.path, join(s.agentHome, "skills"));
	assert.deepEqual(view.skills.paths, [extra]);
	const byName = new Map(view.skills.entries.map((entry) => [entry.name, entry]));
	assert.deepEqual([...byName.keys()].sort(), ["extra-skill", "global-skill", "project-skill"]);
	assert.equal(byName.get("global-skill")?.scope, "user");
	assert.equal(byName.get("project-skill")?.scope, "project");
	// A path in settings.json is not one of the two default folders, and Pi says so itself.
	assert.equal(byName.get("extra-skill")?.scope, "temporary");
	assert.equal(byName.get("global-skill")?.path, join(s.agentHome, "skills", "global-skill", "SKILL.md"));
	assert.equal(byName.get("global-skill")?.description, "One the agent home provides.");
});

test("a settings.json that is not one Pi reads is unavailable, its keys and packages are not invented, and it is left alone", async () => {
	for (const text of ["{not json", "[]", "null", '"settings"']) {
		const s = scratch();
		const path = writeSettings(s, text);
		const view = await settingsRead(s.workspace, s.options);
		assert.equal(view.state, "unavailable", text);
		assert.equal(view.reason, "file-invalid", text);
		assert.equal(view.settings.state, "unavailable", text);
		assert.match(view.settings.message, /settings\.json/, text);
		assert.deepEqual(view.settings.packages, [], "a broken file must not read as an empty package list");
		assert.ok(!("defaultModel" in keysOf(view)), "a broken file must not read as unset keys");
		assert.deepEqual(view.skills.entries, [], "skills still come from disk, not from the broken file");
		assert.equal(readFileSync(path, "utf8"), text, "the file must be left exactly as it was");
	}
});

test("mcp servers are reported with every secret redacted", async () => {
	const s = scratch();
	writeMcp(s, {
		mcpServers: {
			browse: {
				command: "node",
				args: ["server.js", "--api-key=ARG_SECRET_VALUE"],
				env: { API_TOKEN: "ENV_SECRET_VALUE" },
			},
			docs: {
				url: "https://user:PASSWORD_SECRET@mcp.example.com/mcp?token=QUERY_SECRET",
				headers: { Authorization: "Bearer HEADER_SECRET" },
				oauth: { clientSecret: "OAUTH_SECRET" },
				exposure: "direct",
			},
		},
	});
	const view = await settingsRead(s.workspace, s.options);
	assert.equal(view.state, "ok");
	assert.equal(view.mcp.stored, true);

	const browse = view.mcp.servers.find((server) => server.name === "browse");
	assert.deepEqual(browse, {
		name: "browse",
		transport: "stdio",
		enabled: true,
		exposure: "codemode",
		command: "node",
		args: ["server.js", "--api-key=<redacted>"],
		url: null,
		headers: [],
		environment: [{ name: "API_TOKEN", value: "<redacted>" }],
		oauth: false,
	});

	const docs = view.mcp.servers.find((server) => server.name === "docs");
	assert.deepEqual(docs, {
		name: "docs",
		transport: "http",
		enabled: true,
		exposure: "direct",
		command: null,
		args: [],
		// Neither the credentials nor the query string of a URL are reported: a token can live in both.
		url: "https://mcp.example.com/mcp",
		headers: [{ name: "Authorization", value: "<redacted>" }],
		environment: [],
		oauth: true,
	});

	assert.deepEqual(
		leaked(view, ["ARG_SECRET_VALUE", "ENV_SECRET_VALUE", "PASSWORD_SECRET", "QUERY_SECRET", "HEADER_SECRET", "OAUTH_SECRET"]),
		[],
	);
});

test("an mcp.json that is not one Pi reads is unavailable, not an empty list of servers", async () => {
	for (const text of ["{not json", "[]", JSON.stringify({ mcpServers: { broken: { headers: 3 } } })]) {
		const s = scratch();
		const path = writeMcp(s, text);
		const view = await settingsRead(s.workspace, s.options);
		assert.equal(view.state, "unavailable", text);
		assert.equal(view.mcp.state, "unavailable", text);
		assert.equal(view.reason, "file-invalid", text);
		assert.match(view.mcp.message, /mcp\.json/, text);
		assert.deepEqual(view.mcp.servers, [], text);
		assert.equal(readFileSync(path, "utf8"), text, "the file must be left exactly as it was");
	}
});

test("a secret in a broken file does not reach the message either", async () => {
	const s = scratch();
	const secret = "BROKEN_FILE_SECRET";
	writeMcp(s, `{ "mcpServers": { "x": { "url": "https://h/?token=${secret}", "headers": 3 } } }`);
	const view = await settingsRead(s.workspace, s.options);
	assert.equal(view.mcp.state, "unavailable");
	assert.deepEqual(leaked(view, [secret]), []);
});

test("reading writes nothing at all, in either home", async () => {
	const s = scratch();
	writeSettings(s, { defaultModel: "claude-opus-5-5", packages: ["gentle-pi"] });
	skill(join(s.agentHome, "skills"), "a-skill", "A skill.");
	writeMcp(s, { mcpServers: { browse: { command: "node", args: ["server.js"] } } });
	const before = [snapshot(s.agentHome), snapshot(s.configHome)];

	await settingsRead(s.workspace, s.options);

	assert.deepEqual([snapshot(s.agentHome), snapshot(s.configHome)], before);
});

test("the websocket answers a read request, and an action it does not know comes back as an error", async () => {
	const s = scratch();
	writeSettings(s, { defaultProvider: "anthropic", defaultModel: "claude-opus-5-5" });
	writeMcp(s, { mcpServers: { docs: { url: "https://mcp.example.com/mcp?token=WIRE_SECRET" } } });
	const server = await startBridgeServer({ workspace: s.workspace, settings: s.options });
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
		const read = await answer("s1", { kind: "settings", action: "read" });
		assert.equal(read.kind, "settings");
		if (read.kind === "settings") {
			assert.equal(read.action, "read");
			assert.equal(read.data.settings.stored, true);
			assert.deepEqual(leaked(read.data, ["WIRE_SECRET"]), []);
		}

		const unknown = await answer("s2", { kind: "settings", action: "write" });
		assert.equal(unknown.kind, "error", "an action the bridge does not know must be answered");
	} finally {
		ws.close();
		await server.close();
	}
});
