// The Profiles bridge half, exercised against the gentle-pi library installed on this machine.
//
// The profiles file belongs to gentle-pi, so the useful proof is not "our code wrote what our code
// reads" but "gentle-pi's own reader accepts what we wrote". Every test works in a scratch config home
// and agent home under the temp directory: nothing here touches ~/.gentle-shell. A machine without
// gentle-pi skips the integration tests, and the unavailable paths run everywhere.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ProfileRoute, ProfilesActivation, ProfilesView, ServerMessage } from "@gentle-shell/protocol";
import { resolvePiEnvironment } from "../src/pi-environment.ts";
import {
	loadProfilesLibrary,
	profilesActivate,
	profilesCreate,
	profilesDelete,
	profilesList,
	profilesRename,
	profilesSave,
	type ProfilesOptions,
} from "../src/profiles.ts";
import { startBridgeServer } from "../src/server.ts";

const EXTENSION = resolvePiEnvironment().extensionPath;
const integration = { skip: EXTENSION === null ? "gentle-pi is not installed on this machine" : false };

const SEED = {
	kind: "gentle-pi.agent_model_profiles",
	version: 1,
	active: "alpha",
	profiles: {
		alpha: {
			orchestrator: { model: "anthropic/claude-opus-5-5", thinking: "high" },
			"jd-judge-a": { model: "openai/gpt-5", tier: "fast" },
		},
		beta: {
			orchestrator: { model: "openai/gpt-5" },
		},
		quiet: {
			"jd-judge-a": { model: "openai/gpt-5-mini" },
		},
	},
};

interface Scratch {
	readonly configHome: string;
	readonly agentHome: string;
	readonly workspace: string;
	readonly options: ProfilesOptions;
	readonly file: string;
	readonly settings: string;
}

/** A config home with the seed profiles, an empty agent home and a workspace that is not a git repo. */
function scratch(seed: unknown = SEED): Scratch {
	const root = mkdtempSync(join(tmpdir(), "gentle-profiles-"));
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	const workspace = join(root, "work");
	for (const dir of [configHome, agentHome, workspace]) mkdirSync(dir, { recursive: true });
	const file = join(configHome, "profiles.json");
	if (seed !== null) writeFileSync(file, typeof seed === "string" ? seed : `${JSON.stringify(seed, null, 2)}\n`);
	return {
		configHome,
		agentHome,
		workspace,
		file,
		settings: join(agentHome, "settings.json"),
		options: { configHome, agentHome, ...(EXTENSION === null ? {} : { extension: EXTENSION }) },
	};
}

function route(agent: string, model: string | null, thinking: string | null = null, tier: string | null = null): ProfileRoute {
	return { agent, model, thinking, tier };
}

function names(view: ProfilesView): string[] {
	return view.profiles.map((profile) => profile.name);
}

/** gentle-ai keeps its own snapshots in `backups/`, so the profiles file is kept apart from them. */
const BACKUPS = "profiles-backups";

function backups(configHome: string): string[] {
	const dir = join(configHome, BACKUPS);
	return existsSync(dir) ? readdirSync(dir).filter((entry) => entry.startsWith("profiles.")) : [];
}

test("a machine without the library gets a typed unavailable answer, not an empty list", async () => {
	const s = scratch();
	const view = await profilesList(s.workspace, { ...s.options, extension: join(s.workspace, "no-such-gentle-pi") });
	assert.equal(view.state, "unavailable");
	assert.equal(view.reason, "library-missing");
	assert.ok(view.message.length > 0);
	assert.deepEqual(view.profiles, []);
});

test("a library that lacks what the bridge calls is reported as incompatible, naming what is missing", async () => {
	const s = scratch();
	const view = await profilesList(s.workspace, { ...s.options, loadLibrary: async () => ({ createProfile: () => undefined }) });
	assert.equal(view.state, "unavailable");
	assert.equal(view.reason, "library-incompatible");
	assert.match(view.message, /writeProfilesFileSync/);
});

test("lists the stored profiles with their routes, mode and the active one", integration, async () => {
	const s = scratch();
	const view = await profilesList(s.workspace, s.options);
	assert.equal(view.state, "ok");
	assert.equal(view.stored, true);
	assert.equal(view.active, "alpha");
	assert.deepEqual(names(view).sort(), ["alpha", "beta", "quiet"]);

	const alpha = view.profiles.find((profile) => profile.name === "alpha");
	assert.equal(alpha?.active, true);
	assert.equal(alpha?.mode, "organic");
	assert.deepEqual(alpha?.routes.find((entry) => entry.agent === "orchestrator"), route("orchestrator", "anthropic/claude-opus-5-5", "high"));
	assert.deepEqual(alpha?.routes.find((entry) => entry.agent === "jd-judge-a"), route("jd-judge-a", "openai/gpt-5", null, "fast"));
	assert.equal(view.agents[0], "orchestrator", "the orchestrator leads the agent list");
	assert.deepEqual(view.effective, { name: "alpha", source: "active" });
});

test("a missing profiles file lists as nothing stored yet, and is not created by reading", integration, async () => {
	const s = scratch(null);
	const view = await profilesList(s.workspace, s.options);
	assert.equal(view.state, "ok");
	assert.equal(view.stored, false);
	assert.deepEqual(view.profiles, []);
	assert.equal(existsSync(s.file), false);
});

test("a file gentle-pi would not accept is reported, never overwritten", integration, async () => {
	const s = scratch("{not json");
	const view = await profilesList(s.workspace, s.options);
	assert.equal(view.state, "unavailable");
	assert.equal(view.reason, "file-invalid");

	await assert.rejects(() => profilesCreate(s.workspace, "gamma", undefined, s.options), /profiles file/);
	assert.equal(readFileSync(s.file, "utf8"), "{not json");
});

test("what is written is read back by gentle-pi's own reader", integration, async () => {
	const s = scratch();
	await profilesCreate(s.workspace, "gamma", "alpha", s.options);
	await profilesSave(s.workspace, "gamma", [route("orchestrator", "openai/gpt-5", "low"), route("jd-judge-a", "openai/gpt-5-mini")], "full-delegation", s.options);

	const library = await loadProfilesLibrary(EXTENSION as string);
	const parsed = library.parseProfilesFileText(readFileSync(s.file, "utf8"));
	assert.equal(parsed.status, "valid");
	if (parsed.status !== "valid") return;
	// gentle-pi's reader keeps unset fields as undefined in memory; what matters is what is on disk.
	assert.deepEqual(JSON.parse(JSON.stringify(parsed.file.profiles["gamma"])), {
		orchestrator: { model: "openai/gpt-5", thinking: "low" },
		"jd-judge-a": { model: "openai/gpt-5-mini" },
	});
	assert.equal(parsed.file.workflow?.["gamma"]?.orchestratorMode, "full-delegation");
	assert.equal(parsed.file.active, "alpha", "an edit must not move the global default");
});

test("a copy carries the routes and the mode of the profile it came from", integration, async () => {
	const s = scratch();
	await profilesSave(s.workspace, "alpha", [route("orchestrator", "anthropic/claude-opus-5-5", "high")], "full-delegation", s.options);
	const view = await profilesCreate(s.workspace, "copy", "alpha", s.options);
	const copy = view.profiles.find((profile) => profile.name === "copy");
	assert.equal(copy?.mode, "full-delegation");
	assert.deepEqual(copy?.routes, [route("orchestrator", "anthropic/claude-opus-5-5", "high")]);
});

test("a route with nothing set is dropped instead of saved as an empty entry", integration, async () => {
	const s = scratch();
	const view = await profilesSave(s.workspace, "quiet", [route("jd-judge-a", "openai/gpt-5-mini"), route("jd-judge-b", null)], "organic", s.options);
	assert.deepEqual(view.profiles.find((profile) => profile.name === "quiet")?.routes.map((entry) => entry.agent), ["jd-judge-a"]);
});

test("a value gentle-pi would silently drop is refused before anything is written", integration, async () => {
	const s = scratch();
	const before = readFileSync(s.file, "utf8");
	await assert.rejects(() => profilesSave(s.workspace, "beta", [route("orchestrator", "bad model!")], "organic", s.options), /model/);
	await assert.rejects(() => profilesSave(s.workspace, "beta", [route("orchestrator", "openai/gpt-5", "loud")], "organic", s.options), /thinking/);
	await assert.rejects(() => profilesSave(s.workspace, "beta", [route("orchestrator", "openai/gpt-5", null, "turbo")], "organic", s.options), /tier/);
	await assert.rejects(() => profilesSave(s.workspace, "beta", [route("bad agent", "openai/gpt-5")], "organic", s.options), /agent/);
	await assert.rejects(() => profilesSave(s.workspace, "beta", [route("orchestrator", "no-slash")], "organic", s.options), /provider\/model/);
	assert.equal(readFileSync(s.file, "utf8"), before);
});

test("saving a profile that does not exist is refused with gentle-pi's own message", integration, async () => {
	const s = scratch();
	await assert.rejects(() => profilesSave(s.workspace, "ghost", [route("orchestrator", "openai/gpt-5")], "organic", s.options), /does not exist/);
});

test("renaming moves the profile, and onto an existing name is refused", integration, async () => {
	const s = scratch();
	const view = await profilesRename(s.workspace, "beta", "gamma", s.options);
	assert.deepEqual(names(view).sort(), ["alpha", "gamma", "quiet"]);
	await assert.rejects(() => profilesRename(s.workspace, "gamma", "quiet", s.options), /already exists/);
});

test("the active profile cannot be deleted and the file is left exactly as it was", integration, async () => {
	const s = scratch();
	const before = readFileSync(s.file, "utf8");
	await assert.rejects(() => profilesDelete(s.workspace, "alpha", s.options), /active/);
	assert.equal(readFileSync(s.file, "utf8"), before);

	const view = await profilesDelete(s.workspace, "quiet", s.options);
	assert.deepEqual(names(view).sort(), ["alpha", "beta"]);
});

test("the file is backed up once, before the first write, with the bytes it had", integration, async () => {
	const s = scratch();
	const original = readFileSync(s.file, "utf8");
	assert.deepEqual(backups(s.configHome), []);

	await profilesCreate(s.workspace, "gamma", undefined, s.options);
	const first = backups(s.configHome);
	assert.equal(first.length, 1);
	assert.equal(readFileSync(join(s.configHome, BACKUPS, first[0] as string), "utf8"), original);
	assert.equal(existsSync(join(s.configHome, "backups")), false, "gentle-ai's own backups folder must not be touched");

	await profilesCreate(s.workspace, "delta", undefined, s.options);
	assert.equal(backups(s.configHome).length, 1, "a second write in the same run must not pile up backups");
});

test("activating sets the global default and the orchestrator in Pi's settings, keeping its other keys", integration, async () => {
	const s = scratch();
	writeFileSync(s.settings, `${JSON.stringify({ packages: ["x"], defaultProvider: "old", defaultModel: "old" }, null, 2)}\n`);

	const answer: ProfilesActivation = await profilesActivate(s.workspace, "beta", s.options);
	assert.equal(answer.view.active, "beta");
	assert.deepEqual(answer.orchestrator, { provider: "openai", model: "gpt-5", thinking: null });
	assert.equal(answer.pinnedTo, null);

	const settings = JSON.parse(readFileSync(s.settings, "utf8")) as Record<string, unknown>;
	assert.equal(settings["defaultProvider"], "openai");
	assert.equal(settings["defaultModel"], "gpt-5");
	assert.deepEqual(settings["packages"], ["x"]);
	assert.equal((JSON.parse(readFileSync(s.file, "utf8")) as { active: string }).active, "beta");
});

test("a profile that says nothing about the orchestrator leaves Pi's settings alone", integration, async () => {
	const s = scratch();
	const settings = `${JSON.stringify({ defaultProvider: "keep", defaultModel: "keep" }, null, 2)}\n`;
	writeFileSync(s.settings, settings);

	const answer = await profilesActivate(s.workspace, "quiet", s.options);
	assert.equal(answer.orchestrator, null);
	assert.equal(readFileSync(s.settings, "utf8"), settings);
	assert.equal(answer.view.active, "quiet");
});

test("activating is all or nothing: unreadable settings stop it before the default moves", integration, async () => {
	const s = scratch();
	writeFileSync(s.settings, "{broken");
	const before = readFileSync(s.file, "utf8");

	await assert.rejects(() => profilesActivate(s.workspace, "beta", s.options), /settings/);
	assert.equal(readFileSync(s.file, "utf8"), before);
	assert.equal(readFileSync(s.settings, "utf8"), "{broken");
});

test("a repository pin that wins over the default is reported, for the view and for activation", integration, async () => {
	const s = scratch();
	execFileSync("git", ["init", "-q", s.workspace]);
	const pinDir = join(s.workspace, ".git", "gentle-ai");
	mkdirSync(pinDir, { recursive: true });
	writeFileSync(
		join(pinDir, "profile-pin.json"),
		`${JSON.stringify({ kind: "gentle-pi.agent_model_profile_pin", version: 1, profile: "quiet" })}\n`,
	);

	const view = await profilesList(s.workspace, s.options);
	assert.deepEqual(view.effective, { name: "quiet", source: "pin-local" });

	const answer = await profilesActivate(s.workspace, "beta", s.options);
	assert.equal(answer.pinnedTo, "quiet");
	assert.equal(answer.view.active, "beta");
});

test("a change made outside the bridge between two writes is backed up too", integration, async () => {
	const s = scratch();
	await profilesCreate(s.workspace, "gamma", undefined, s.options);
	assert.equal(backups(s.configHome).length, 1);

	// The terminal edits the file while the bridge is running.
	const outside = `${JSON.stringify({ ...SEED, active: "beta" }, null, 2)}\n`;
	writeFileSync(s.file, outside);
	await profilesCreate(s.workspace, "delta", undefined, s.options);

	const kept = backups(s.configHome).map((name) => readFileSync(join(s.configHome, BACKUPS, name), "utf8"));
	assert.equal(kept.length, 2);
	assert.ok(kept.includes(outside), "the bytes the terminal wrote were not kept");
});

test("an agent name that would reach the prototype is refused, not accepted and dropped", integration, async () => {
	const s = scratch();
	const before = readFileSync(s.file, "utf8");
	for (const agent of ["__proto__", "constructor", "prototype"]) {
		await assert.rejects(() => profilesSave(s.workspace, "beta", [route(agent, "openai/gpt-5")], "organic", s.options), /agent/);
	}
	assert.equal(readFileSync(s.file, "utf8"), before);
});

test("what gentle-pi's reader drops without a word is named in the notes, and kept in the backup", integration, async () => {
	const seed = {
		...SEED,
		futureKey: { kept: "by someone else" },
		profiles: { ...SEED.profiles, alpha: { orchestrator: { model: "openai/gpt-5", extra: "unknown" } } },
	};
	const s = scratch(seed);
	const view = await profilesList(s.workspace, s.options);
	assert.ok(view.notes.some((note) => note.includes("futureKey")), `no note for the unknown top-level key: ${JSON.stringify(view.notes)}`);
	assert.ok(view.notes.some((note) => note.includes("extra") && note.includes("alpha")), `no note for the unknown field: ${JSON.stringify(view.notes)}`);

	const original = readFileSync(s.file, "utf8");
	const after = await profilesCreate(s.workspace, "gamma", undefined, s.options);
	assert.deepEqual(after.notes, [], "after a save the file is the normalized one, so there is nothing left to warn about");
	assert.equal(readFileSync(join(s.configHome, BACKUPS, backups(s.configHome)[0] as string), "utf8"), original);
});

test("a legacy effort field is a conversion, not a loss, and is not warned about", integration, async () => {
	const s = scratch({ ...SEED, profiles: { alpha: { orchestrator: { model: "openai/gpt-5", effort: "high" } } } });
	const view = await profilesList(s.workspace, s.options);
	assert.deepEqual(view.notes, []);
});

test("the websocket answers a profiles request, and a refused change comes back as an error", integration, async () => {
	const s = scratch();
	const server = await startBridgeServer({ workspace: s.workspace, profiles: s.options });
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
		const listed = await answer("p1", { kind: "profiles", action: "list" });
		assert.equal(listed.kind, "profiles");
		if (listed.kind === "profiles" && listed.action === "list") assert.deepEqual(names(listed.data).sort(), ["alpha", "beta", "quiet"]);

		const unknown = await answer("p3", { kind: "profiles", action: "bogus" });
		assert.equal(unknown.kind, "error", "a request the bridge does not understand must be answered, not left waiting");

		const refused = await answer("p2", { kind: "profiles", action: "create", name: "alpha" });
		assert.equal(refused.kind, "error");
		if (refused.kind === "error") assert.match(refused.message, /already exists/);
	} finally {
		ws.close();
		await server.close();
	}
});
