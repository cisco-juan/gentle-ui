// Themes: Gentle Shell's own selection, read by the UI and written back through one key of Pi's settings.
//
// The write is the risky half. `settings.json` belongs to Pi and holds the packages, the default model and
// the permission defaults this bridge only ever reads, so the tests that matter are the refusals and the
// backup: a name the catalog does not carry is not written, a file that does not parse is left alone, and
// the bytes a write replaces survive under the profiles backup folder. Every test works in a scratch tree
// under the temp directory; nothing here touches ~/.gentle-shell.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ServerMessage } from "@gentle-shell/protocol";
import { startBridgeServer } from "../src/server.ts";
import {
	appearanceRead,
	appearanceSetTheme,
	catalogOf,
	resolveTheme,
	themeFiles,
	type AppearanceOptions,
} from "../src/appearance.ts";

/** A theme in Pi's own shape, as `Gentleman-Sexy.json` writes it. */
const SEXY = {
	name: "Gentleman-Sexy",
	vars: {
		bg: "#060407",
		bgElement: "#100A0F",
		border: "#563040",
		borderSubtle: "#2A1720",
		text: "#F6EFF3",
		muted: "#A78E9B",
		dim: "#76616B",
		accent: "#F43888",
		mint: "#B4E7C7",
		peach: "#F2B86D",
		error: "#FF718F",
		selection: "#28121E",
		userMessageBg: "#2E0F1F",
	},
	colors: {
		text: "text",
		muted: "muted",
		dim: "dim",
		accent: "accent",
		border: "border",
		borderMuted: "borderSubtle",
		success: "mint",
		warning: "peach",
		error: "error",
		selectedBg: "selection",
		userMessageBg: "userMessageBg",
		thinkingOff: "borderSubtle",
	},
	export: { pageBg: "bg", cardBg: "bgElement" },
};

interface Scratch {
	readonly root: string;
	readonly options: AppearanceOptions;
	readonly settings: string;
	readonly backups: string;
}

/** Every scratch tree this file made, removed once its tests are done. */
const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A built-in, a package and a user theme folder, a config home and an agent home. */
function scratch(): Scratch {
	const root = mkdtempSync(join(tmpdir(), "gentle-appearance-"));
	roots.push(root);
	const builtin = join(root, "builtin");
	const extension = join(root, "extension");
	const user = join(root, "user");
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	for (const dir of [builtin, extension, user, configHome, agentHome]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(builtin, "dark.json"), JSON.stringify({ name: "dark", vars: { text: "#E7E7E7" }, colors: { text: "text", accent: "#B79BF2" }, export: { pageBg: "#1A1A1F" } }));
	writeFileSync(join(builtin, "light.json"), JSON.stringify({ name: "light", vars: { text: "#2A2A30" }, colors: { text: "text" }, export: { pageBg: "#F4F4F5" } }));
	writeFileSync(join(extension, "Gentleman-Sexy.json"), JSON.stringify(SEXY));
	writeFileSync(join(user, "Mine.json"), JSON.stringify({ name: "Mine", colors: { text: "#FFFFFF" } }));
	return {
		root,
		options: { configHome, agentHome, themeRoots: { builtin, extension, user } },
		settings: join(agentHome, "settings.json"),
		backups: join(configHome, "profiles-backups"),
	};
}

function writeSettings(s: Scratch, value: unknown): void {
	writeFileSync(s.settings, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

// ---- one theme, resolved ----

test("a theme's semantic colours resolve against its own vars, and its export pair too", () => {
	const theme = resolveTheme(SEXY, ["Gentleman-Sexy"]);
	assert.deepEqual(theme?.name, "Gentleman-Sexy");
	assert.equal(theme?.tokens["text"], "#F6EFF3");
	assert.equal(theme?.tokens["accent"], "#F43888");
	assert.equal(theme?.tokens["borderMuted"], "#2A1720");
	assert.equal(theme?.tokens["success"], "#B4E7C7");
	assert.equal(theme?.tokens["pageBg"], "#060407");
	assert.equal(theme?.tokens["cardBg"], "#100A0F");
	// A palette-only var is the theme's own business, and thinking state is not chrome.
	assert.equal(theme?.tokens["mint"], undefined);
	assert.equal(theme?.tokens["thinkingOff"], undefined);
});

test("a theme that leaves an optional colour out keeps every one it has", () => {
	const partial = { name: "Sparse", colors: { text: "#ABCDEF", accent: "missingVar" } };
	const theme = resolveTheme(partial, ["Sparse"]);
	assert.equal(theme?.tokens["text"], "#ABCDEF");
	// Pi resolves an unknown reference to itself; a value a webview cannot paint is dropped later.
	assert.equal(theme?.tokens["accent"], "missingVar");
	for (const absent of ["selectedBg", "pageBg", "cardBg", "warning"]) assert.equal(theme?.tokens[absent], undefined);
});

test("an unknown, unnamed or colourless document is not a theme", () => {
	assert.equal(resolveTheme(SEXY, ["Gentleman-Cute"]), null);
	assert.equal(resolveTheme(SEXY, []), null);
	assert.equal(resolveTheme(null, ["Gentleman-Sexy"]), null);
	assert.equal(resolveTheme({ name: "X" }, ["X"]), null);
	assert.equal(resolveTheme({ name: "X", colors: {} }, ["X"]), null);
	assert.equal(resolveTheme({ name: "a/b", colors: { text: "#FFF" } }, ["a/b"]), null);
});

// ---- the catalog ----

test("the catalog merges the three places and a later definition of a name wins", () => {
	const catalog = catalogOf([
		{ name: "system", source: "builtin", path: null },
		{ name: "dark", source: "builtin", path: null },
		{ name: "Gentle", source: "gentle-pi", path: null },
		{ name: "Gentleman-Sexy", source: "gentle-pi", path: null },
		{ name: "Gentle", source: "user", path: null },
	]);
	assert.deepEqual(
		catalog.map((entry) => `${entry.name}:${entry.source}`),
		["system:builtin", "dark:builtin", "Gentle:user", "Gentleman-Sexy:gentle-pi"],
	);
});

test("the reader lists the three folders, and nothing a symlink points outside them", () => {
	const s = scratch();
	const outside = mkdtempSync(join(tmpdir(), "gentle-appearance-outside-"));
	roots.push(outside);
	writeFileSync(join(outside, "Escape.json"), JSON.stringify({ name: "Escape", colors: { text: "#FFFFFF" } }));
	symlinkSync(join(outside, "Escape.json"), join(s.options.themeRoots?.user ?? "", "Escape.json"));

	const files = themeFiles(s.options);
	const names = catalogOf(files).map((entry) => `${entry.name}:${entry.source}`);
	assert.deepEqual(names, ["system:builtin", "dark:builtin", "Gentleman-Sexy:gentle-pi", "light:builtin", "Mine:user"]);
});

// ---- reading ----

test("reading reports the selected theme, its tokens and the rose's own two files", async () => {
	const s = scratch();
	writeSettings(s, { theme: "Gentleman-Sexy", defaultProvider: "p", packages: ["npm:x"] });
	writeFileSync(join(s.options.configHome ?? "", "banner.json"), '{"showRose":false}');
	writeFileSync(join(s.options.configHome ?? "", "animations.json"), '{"schema":"gentle-pi.animations/v1","policy":"potato"}');

	const view = await appearanceRead(s.options);
	assert.equal(view.state, "ok");
	assert.equal(view.theme.current, "Gentleman-Sexy");
	assert.deepEqual(
		view.theme.available.map((entry) => entry.name),
		["system", "dark", "Gentleman-Sexy", "light", "Mine"],
	);
	assert.equal(view.theme.tokens?.tokens["text"], "#F6EFF3");
	assert.deepEqual(view.rose, { banner: '{"showRose":false}', animations: '{"schema":"gentle-pi.animations/v1","policy":"potato"}' });
	assert.equal(readFileSync(s.settings, "utf8").includes('"theme": "Gentleman-Sexy"'), true);
});

test("a settings file that does not parse is reported, never repaired", async () => {
	const s = scratch();
	const broken = "{ not json";
	writeSettings(s, broken);
	const view = await appearanceRead(s.options);
	assert.equal(view.state, "unavailable");
	assert.equal(view.reason, "file-invalid");
	assert.equal(view.theme.current, null);
	assert.equal(readFileSync(s.settings, "utf8"), broken);
});

// ---- writing ----

test("choosing a theme writes that one key and keeps the bytes it replaced", async () => {
	const s = scratch();
	const before = `${JSON.stringify({ theme: "Mine", packages: ["npm:x"], images: { blockImages: false } }, null, 2)}\n`;
	writeSettings(s, before);

	const view = await appearanceSetTheme("Gentleman-Sexy", s.options);
	assert.equal(view.theme.current, "Gentleman-Sexy");
	assert.equal(view.theme.tokens?.tokens["accent"], "#F43888");

	const after = readFileSync(s.settings, "utf8");
	assert.deepEqual(JSON.parse(after), { theme: "Gentleman-Sexy", packages: ["npm:x"], images: { blockImages: false } });
	assert.equal(after.endsWith("}\n"), true, "the file's own final newline survives");
	assert.equal(after.includes('\n  "packages"'), true, "the file's own indentation survives");
	assert.deepEqual(readdirSync(s.backups).length, 1);
	const [backup] = readdirSync(s.backups);
	assert.equal(readFileSync(join(s.backups, backup ?? ""), "utf8"), before);
});

test("a name the catalog does not carry is refused, and the file is untouched", async () => {
	const s = scratch();
	const before = `${JSON.stringify({ theme: "Mine" }, null, 2)}\n`;
	writeSettings(s, before);
	await assert.rejects(() => appearanceSetTheme("Comic-Sans", s.options), /not a theme this machine has/);
	assert.equal(readFileSync(s.settings, "utf8"), before);
	assert.equal(existsSync(s.backups), false);
});

test("a settings file that cannot be parsed is never replaced by a write", async () => {
	const s = scratch();
	const broken = '{"theme": "Mine",';
	writeSettings(s, broken);
	await assert.rejects(() => appearanceSetTheme("Gentleman-Sexy", s.options), /left alone/);
	assert.equal(readFileSync(s.settings, "utf8"), broken);
});

// ---- the wire ----

test("the family answers over the bridge, and a refusal arrives as an error instead of a silence", async () => {
	const s = scratch();
	writeSettings(s, { theme: "Mine" });
	const server = await startBridgeServer({ workspace: s.root, appearance: s.options });
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
		const read = await answer("a1", { kind: "appearance", action: "read" });
		assert.equal(read.kind, "appearance");
		if (read.kind === "appearance") assert.equal(read.data.theme.current, "Mine");

		const refused = await answer("a2", { kind: "appearance", action: "theme", name: "Comic-Sans" });
		assert.equal(refused.kind, "error");
		assert.equal(readFileSync(s.settings, "utf8").includes('"theme": "Mine"'), true);

		const unknown = await answer("a3", { kind: "appearance", action: "bogus" });
		assert.equal(unknown.kind, "error", "an action the bridge does not know must be answered");

		const chosen = await answer("a4", { kind: "appearance", action: "theme", name: "Gentleman-Sexy" });
		assert.equal(chosen.kind, "appearance");
		if (chosen.kind === "appearance") assert.equal(chosen.data.theme.current, "Gentleman-Sexy");
	} finally {
		ws.close();
		await server.close();
	}
});
