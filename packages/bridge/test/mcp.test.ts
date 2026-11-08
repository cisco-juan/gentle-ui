// The MCP family: the one writer whose subject is mostly credentials.
//
// Two things are at stake here, and they pull in opposite directions. The first is that a person can
// add, edit and remove a server from the sheet at all — a stdio command or an http URL, with the
// fields Pi validates. The second is that the sheet never sees a secret: a header or environment
// value is reported as `<redacted>`, a URL is reduced to scheme, host and path, the file's own text
// never travels, and an error message never quotes it.
//
// The third thing is the confirmation, shared with the packages family: `preview` returns a plan and
// its digest, `apply` sends it back, a plan is used once, and a file that moved in between is never
// overwritten. All of that lives in `config-write.ts`; these tests check that this family is actually
// behind it.
//
// Everything runs against real files in scratch homes under the temp directory and against Pi's own
// compiled MCP modules: nothing here fakes a filesystem, and nothing reaches a network.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { WebSocket } from "ws";
import type { ServerMessage } from "@gentle-shell/protocol";
import { mcpApply, mcpList, mcpPreview, type McpOptions } from "../src/mcp.ts";
import { startBridgeServer } from "../src/server.ts";

/** Values that exist only to be searched for: no answer this family gives may contain one. */
const HEADER_SECRET = "Bearer sk-live-a1b2c3d4";
const TRACE_SECRET = "trace-77c9";
const ENV_SECRET = "sk-env-5e6f7g";
const URL_USER = "urluser";
const URL_PASSWORD = "urlpassword-8h9i";
const URL_TOKEN = "urltoken-0j1k";
const ADDED_ENV_SECRET = "sk-added-env-2l3m";
const BROKEN_FILE_TEXT = `Authorization: ${HEADER_SECRET} not json\n`;
const RAW_FILE_MARKER = "raw-file-text-marker-9f3";

/** Every value above, so one loop can prove no answer carries any of them. */
const SECRETS = [HEADER_SECRET, TRACE_SECRET, ENV_SECRET, URL_PASSWORD, URL_TOKEN, ADDED_ENV_SECRET, RAW_FILE_MARKER];

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
	const root = mkdtempSync(join(tmpdir(), "gentle-mcp-"));
	scratchRoots.push(root);
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	const workspace = join(root, "work");
	for (const dir of [configHome, agentHome, workspace]) mkdirSync(dir, { recursive: true });
	return { root, configHome, agentHome, workspace, path: join(agentHome, "mcp.json") };
}

/** Write `mcp.json` as text, so a test controls its indentation and its final newline. */
function writeMcp(s: Scratch, value: unknown): string {
	const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 4)}\n`;
	writeFileSync(s.path, text);
	return text;
}

/** The two servers every write test starts from: one http with credentials, one stdio with a header-like env. */
function seeded(): Record<string, unknown> {
	return {
		mcpServers: {
			docs: {
				url: `https://${URL_USER}:${URL_PASSWORD}@docs.example.com/mcp?token=${URL_TOKEN}`,
				headers: { Authorization: HEADER_SECRET, "X-Trace": TRACE_SECRET },
			},
			filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
		},
		[`_${RAW_FILE_MARKER}`]: RAW_FILE_MARKER,
	};
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

/** The family's own options: the two scratch homes, and Pi's real modules behind them. */
function options(s: Scratch): McpOptions {
	return { configHome: s.configHome, agentHome: s.agentHome };
}

function serversOnDisk(s: Scratch): Record<string, Record<string, unknown>> {
	const parsed = JSON.parse(readFileSync(s.path, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
	return parsed.mcpServers ?? {};
}

/** No answer may carry a credential or the file's own text; this is the assertion C4 rests on. */
function assertNoSecrets(answer: unknown, where: string): void {
	const text = JSON.stringify(answer);
	for (const secret of SECRETS) {
		assert.equal(text.includes(secret), false, `${where} must not carry ${JSON.stringify(secret)}`);
	}
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

test("a list is what Pi loads from the agent's mcp.json, with every credential replaced by <redacted>", async () => {
	const s = scratch();
	writeMcp(s, {
		mcpServers: {
			docs: {
				url: `https://${URL_USER}:${URL_PASSWORD}@docs.example.com/mcp?token=${URL_TOKEN}`,
				headers: { Authorization: HEADER_SECRET, "X-Trace": TRACE_SECRET },
				auth: { provider: "openai" },
			},
			filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], env: { API_KEY: ENV_SECRET } },
		},
	});

	const view = await mcpList(s.workspace, options(s));

	assert.equal(view.state, "ok");
	assert.equal(view.reason, null);
	assert.equal(view.path, s.path);
	assert.equal(view.stored, true);
	assert.equal(view.plan, null);
	assert.equal(view.change, null);
	assert.equal(view.backup, null);
	assert.deepEqual(view.servers.map((server) => server.name), ["docs", "filesystem"]);

	assert.deepEqual(view.servers[0], {
		name: "docs",
		transport: "http",
		enabled: true,
		exposure: "codemode",
		command: null,
		args: [],
		// The credentials in the userinfo and the token in the query string are both cut out.
		url: "https://docs.example.com/mcp",
		headers: [
			{ name: "Authorization", value: "<redacted>" },
			{ name: "X-Trace", value: "<redacted>" },
		],
		environment: [],
		oauth: true,
	});
	assert.deepEqual(view.servers[1], {
		name: "filesystem",
		transport: "stdio",
		enabled: true,
		exposure: "codemode",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
		url: null,
		headers: [],
		environment: [{ name: "API_KEY", value: "<redacted>" }],
		oauth: false,
	});

	assertNoSecrets(view, "the list");
});

test("with no mcp.json the list is empty, says so, and creates nothing", async () => {
	const s = scratch();
	const view = await mcpList(s.workspace, options(s));

	assert.equal(view.state, "ok");
	assert.equal(view.stored, false);
	assert.deepEqual(view.servers, []);
	assert.equal(view.notes.some((note) => note.includes("does not exist yet")), true);
	assert.deepEqual(readdirSync(s.agentHome), [], "listing must not create an mcp.json");
});

test("an mcp.json Pi cannot parse is unavailable, quotes nothing, and is never replaced", async () => {
	const s = scratch();
	writeMcp(s, BROKEN_FILE_TEXT);

	const list = await mcpList(s.workspace, options(s));
	assert.equal(list.state, "unavailable");
	assert.equal(list.reason, "file-invalid");
	assert.match(list.message, /mcp\.json/);
	assert.deepEqual(list.servers, [], "a broken file must not read as an empty server list");
	assertNoSecrets(list, "the unavailable list");
	// The parse error V8 reports quotes the beginning of the file; that prefix is a secret here.
	assert.equal(list.message.includes("Authorizat"), false, "the quoted prefix of the file is not repeated");
	assert.match(list.message, /not valid JSON/, "the reason Pi's reader gave is still there");

	const preview = await mcpPreview(s.workspace, { operation: "add", name: "added", server: { transport: "stdio", command: "npx" } }, options(s));
	assert.equal(preview.state, "unavailable");
	assert.equal(preview.reason, "file-invalid");
	assert.equal(preview.plan, null, "there is no plan to confirm for a file that cannot be read");
	assertNoSecrets(preview, "the unavailable preview");
	assert.equal(preview.message.includes("Authorizat"), false, "the quoted prefix of the file is not repeated");

	// Even a digest of the right shape cannot get past a file that cannot be read.
	const applied = await mcpApply(
		s.workspace,
		{ operation: "add", name: "added", server: { transport: "stdio", command: "npx" } },
		"0".repeat(64),
		options(s),
	);
	assert.equal(applied.state, "unavailable");
	assert.equal(applied.reason, "file-invalid");
	assertNoSecrets(applied, "the unavailable apply");

	assert.equal(readFileSync(s.path, "utf8"), BROKEN_FILE_TEXT, "the broken file is left exactly as it was");
});

test("a parse error that quotes no text keeps its position, so the reason is still useful", async () => {
	const s = scratch();
	writeMcp(s, `{\n    "mcpServers": {\n        "docs": {"url": "https://docs.example.com/mcp" "headers": {}}\n}`);
	const view = await mcpList(s.workspace, options(s));

	assert.equal(view.state, "unavailable");
	assert.equal(view.reason, "file-invalid");
	assert.match(view.message, /position \d+/);
});

test("an mcpServers value that is not an object is unavailable and is never replaced", async () => {
	for (const value of [{ mcpServers: [] }, { mcpServers: "docs" }, []]) {
		const s = scratch();
		const original = writeMcp(s, value);

		const list = await mcpList(s.workspace, options(s));
		assert.equal(list.state, "unavailable", JSON.stringify(value));
		assert.equal(list.reason, "file-invalid", JSON.stringify(value));

		const preview = await mcpPreview(
			s.workspace,
			{ operation: "add", name: "added", server: { transport: "stdio", command: "npx" } },
			options(s),
		);
		assert.equal(preview.state, "unavailable", JSON.stringify(value));
		assert.equal(preview.reason, "file-invalid", JSON.stringify(value));
		assert.equal(readFileSync(s.path, "utf8"), original, "the file this cannot read is left alone");
	}
});

test("a preview of an add shows the plan, writes nothing, and sends neither the new secret nor the file's text", async () => {
	const s = scratch();
	writeMcp(s, seeded());
	const before = [snapshot(s.agentHome), snapshot(s.configHome)];

	const preview = await mcpPreview(
		s.workspace,
		{ operation: "add", name: "added", server: { transport: "stdio", command: "npx", args: ["-y", "pkg"], env: { API_KEY: ADDED_ENV_SECRET } } },
		options(s),
	);

	assert.equal(preview.state, "ok");
	assert.equal(preview.reason, null);
	assert.notEqual(preview.plan, null);
	assert.equal(preview.plan?.operation, "mcp.add");
	assert.equal(preview.plan?.target, s.path);
	assert.match(preview.plan?.digest ?? "", /^[0-9a-f]{64}$/);
	assert.deepEqual(preview.plan?.summary, ['mcp: add server "added" (stdio)', "mcp: servers 2 → 3"]);
	assert.deepEqual(preview.change?.before, null);
	assert.equal(preview.change?.after?.name, "added");
	assert.equal(preview.change?.after?.command, "npx");
	assert.deepEqual(preview.change?.after?.environment, [{ name: "API_KEY", value: "<redacted>" }]);
	assert.deepEqual(preview.servers.map((server) => server.name), ["docs", "filesystem"], "the preview reports the file as it is");
	assert.equal(preview.backup, null);
	assertNoSecrets(preview, "the add preview");

	assert.deepEqual([snapshot(s.agentHome), snapshot(s.configHome)], before, "a preview writes nothing in either home");

	// One plan, one digest: asking twice cannot change what the confirmation would show.
	const again = await mcpPreview(
		s.workspace,
		{ operation: "add", name: "added", server: { transport: "stdio", command: "npx", args: ["-y", "pkg"], env: { API_KEY: ADDED_ENV_SECRET } } },
		options(s),
	);
	assert.equal(again.plan?.digest, preview.plan?.digest);
});

test("an apply with the confirmed digest adds a stdio server, keeps everything else, and backs the old bytes up", async () => {
	const s = scratch();
	const original = writeMcp(s, seeded());

	const preview = await mcpPreview(
		s.workspace,
		{ operation: "add", name: "added", server: { transport: "stdio", command: "npx", args: ["-y", "pkg"], env: { API_KEY: ADDED_ENV_SECRET } } },
		options(s),
	);
	const applied = await mcpApply(
		s.workspace,
		{ operation: "add", name: "added", server: { transport: "stdio", command: "npx", args: ["-y", "pkg"], env: { API_KEY: ADDED_ENV_SECRET } } },
		preview.plan?.digest,
		options(s),
	);

	assert.equal(applied.state, "ok");
	assert.equal(applied.reason, null);
	assert.deepEqual(applied.servers.map((server) => server.name), ["added", "docs", "filesystem"]);
	assertNoSecrets(applied, "the applied add");

	const written = readFileSync(s.path, "utf8");
	assert.match(written, /\n {4}"mcpServers"/, "the file's own indentation is kept");
	assert.ok(written.endsWith("\n"), "the file's final newline is kept");
	assert.equal(statSync(s.path).mode & 0o777, 0o600);

	const parsed = JSON.parse(written) as Record<string, unknown>;
	assert.equal(parsed[`_${RAW_FILE_MARKER}`], RAW_FILE_MARKER, "a key this family does not own is kept");
	const servers = serversOnDisk(s);
	assert.deepEqual(servers["added"], { command: "npx", args: ["-y", "pkg"], env: { API_KEY: ADDED_ENV_SECRET } });
	// The server it did not touch keeps its credentials on disk, where they belong.
	assert.deepEqual(servers["docs"]?.["headers"], { Authorization: HEADER_SECRET, "X-Trace": TRACE_SECRET });

	const backups = readdirSync(join(s.configHome, "mcp-backups"));
	assert.equal(backups.length, 1);
	assert.match(backups[0] ?? "", /^mcp\..+\.json$/);
	assert.equal(applied.backup, join(s.configHome, "mcp-backups", backups[0] ?? ""));
	assert.equal(readFileSync(applied.backup ?? "", "utf8"), original);
});

test("an http server can be added, and its url is never sent with the credentials it arrived with", async () => {
	const s = scratch();
	writeMcp(s, seeded());
	const url = `https://${URL_USER}:${URL_PASSWORD}@api.example.com/mcp?token=${URL_TOKEN}`;
	const request = { operation: "add" as const, name: "api", server: { transport: "http" as const, url } };

	const preview = await mcpPreview(s.workspace, request, options(s));
	assert.equal(preview.state, "ok");
	assert.equal(preview.change?.after?.transport, "http");
	assert.equal(preview.change?.after?.url, "https://api.example.com/mcp");
	assert.equal(preview.change?.before, null);
	assertNoSecrets(preview, "the http preview");

	const applied = await mcpApply(s.workspace, request, preview.plan?.digest, options(s));
	assert.equal(applied.state, "ok");
	assert.equal(serversOnDisk(s)["api"]?.["url"], url, "the url is written exactly as the person gave it");
	assert.equal(applied.change?.after?.url, "https://api.example.com/mcp");
	assertNoSecrets(applied, "the applied http add");
});

test("an update keeps a header it was not asked to change, and never sends its value anywhere", async () => {
	const s = scratch();
	const original = writeMcp(s, seeded());

	// The panel changes the command of the stdio server. The http server's headers — the secret ones —
	// are not in the request at all, which is the whole point: they are never read out and sent back.
	const request = { operation: "update" as const, name: "filesystem", server: { command: "node", args: ["server.js"] } };
	const preview = await mcpPreview(s.workspace, request, options(s));

	assert.equal(preview.state, "ok");
	assert.deepEqual(preview.plan?.summary, ['mcp: update server "filesystem": command, args', "mcp: servers 2 → 2"]);
	assert.equal(preview.change?.before?.command, "npx");
	assert.equal(preview.change?.after?.command, "node");
	assert.deepEqual(preview.change?.after?.args, ["server.js"]);
	// The plan may show that a header exists, with its value replaced.
	assert.deepEqual(preview.change?.after?.environment, []);
	assertNoSecrets(preview, "the update preview");

	const applied = await mcpApply(s.workspace, request, preview.plan?.digest, options(s));
	assert.equal(applied.state, "ok");
	assert.equal(readFileSync(applied.backup ?? "", "utf8"), original);

	const servers = serversOnDisk(s);
	assert.equal(servers["filesystem"]?.["command"], "node");
	assert.deepEqual(servers["filesystem"]?.["args"], ["server.js"]);
	assert.deepEqual(servers["docs"]?.["headers"], { Authorization: HEADER_SECRET, "X-Trace": TRACE_SECRET });
	assertNoSecrets(applied, "the applied update");
});

test("an update of a secret field replaces only the field it names", async () => {
	const s = scratch();
	writeMcp(s, { mcpServers: { docs: { url: "https://docs.example.com/mcp", headers: { Authorization: HEADER_SECRET, "X-Trace": TRACE_SECRET } } } });

	const request = { operation: "update" as const, name: "docs", server: { headers: { Authorization: "Bearer rotated-4n5o" } } };
	const preview = await mcpPreview(s.workspace, request, options(s));
	const applied = await mcpApply(s.workspace, request, preview.plan?.digest, options(s));

	assert.equal(applied.state, "ok");
	assert.deepEqual(serversOnDisk(s)["docs"]?.["headers"], { Authorization: "Bearer rotated-4n5o" }, "a header map given in full is written in full");
	assert.equal(applied.change?.after?.url, "https://docs.example.com/mcp", "the url is untouched");
	assert.equal(JSON.stringify(applied).includes("rotated-4n5o"), false, "the new value is a secret too, and is not echoed");
	assert.equal(JSON.stringify(applied).includes(HEADER_SECRET), false);
});

test("an update that would change nothing is refused, and nothing is written", async () => {
	const s = scratch();
	const original = writeMcp(s, seeded());

	// The command the file already has, spelled exactly as the request spells it.
	await assert.rejects(
		() => mcpPreview(s.workspace, { operation: "update", name: "filesystem", server: { command: "npx" } }, options(s)),
		/would hold exactly/,
	);
	await assert.rejects(
		() => mcpPreview(s.workspace, { operation: "update", name: "filesystem", server: {} }, options(s)),
		/names no field/,
	);
	assert.equal(readFileSync(s.path, "utf8"), original);
});

test("an update of `enabled` or `exposure` alone is made by Pi's own patch, so a default stays elided", async () => {
	const s = scratch();
	writeMcp(s, {
		mcpServers: { filesystem: { command: "npx", args: ["-y", "pkg"], enabled: false, exposure: "direct" } },
	});

	// Pi deletes a key that holds the default instead of writing it, and this family uses that writer for
	// exactly the two fields it understands.
	const request = { operation: "update" as const, name: "filesystem", server: { enabled: true, exposure: "codemode" } };
	const preview = await mcpPreview(s.workspace, request, options(s));
	assert.equal(preview.state, "ok");
	assert.equal(preview.change?.before?.enabled, false);
	assert.equal(preview.change?.after?.enabled, true);

	const applied = await mcpApply(s.workspace, request, preview.plan?.digest, options(s));
	assert.equal(applied.state, "ok");
	const entry = serversOnDisk(s)["filesystem"] ?? {};
	assert.equal("enabled" in entry, false, "the default is elided, as Pi's own writer leaves it");
	assert.equal("exposure" in entry, false);
	assert.equal(preview.change?.after?.exposure, "codemode");
});

test("a remove takes the server out, keeps a backup, and shows the entry it removed", async () => {
	const s = scratch();
	const original = writeMcp(s, seeded());

	const preview = await mcpPreview(s.workspace, { operation: "remove", name: "docs" }, options(s));
	assert.equal(preview.state, "ok");
	assert.equal(preview.change?.before?.name, "docs");
	assert.equal(preview.change?.after, null);
	assert.deepEqual(preview.servers.map((server) => server.name), ["docs", "filesystem"]);
	assertNoSecrets(preview, "the remove preview");

	const applied = await mcpApply(s.workspace, { operation: "remove", name: "docs" }, preview.plan?.digest, options(s));
	assert.equal(applied.state, "ok");
	assert.deepEqual(Object.keys(serversOnDisk(s)), ["filesystem"]);
	assert.equal(readFileSync(applied.backup ?? "", "utf8"), original);
	assertNoSecrets(applied, "the applied remove");
});

test("adding a name that exists, or removing one that does not, is refused and writes nothing", async () => {
	const s = scratch();
	const original = writeMcp(s, seeded());

	await assert.rejects(
		() => mcpPreview(s.workspace, { operation: "add", name: "docs", server: { transport: "stdio", command: "npx" } }, options(s)),
		/already defines/,
	);
	await assert.rejects(() => mcpPreview(s.workspace, { operation: "remove", name: "absent" }, options(s)), /does not define/);
	await assert.rejects(
		() => mcpPreview(s.workspace, { operation: "update", name: "absent", server: { command: "npx" } }, options(s)),
		/does not define/,
	);
	assert.equal(readFileSync(s.path, "utf8"), original);
});

test("an apply without the digest the confirmation showed is refused and nothing is written", async () => {
	const s = scratch();
	const original = writeMcp(s, seeded());
	const request = { operation: "add" as const, name: "added", server: { transport: "stdio" as const, command: "npx" } };
	await mcpPreview(s.workspace, request, options(s));

	for (const digest of [undefined, "", "   "]) {
		await assert.rejects(() => mcpApply(s.workspace, request, digest, options(s)), /digest/);
		assert.equal(readFileSync(s.path, "utf8"), original);
	}
});

test("an apply whose digest describes another plan is refused as a stale plan", async () => {
	const s = scratch();
	const original = writeMcp(s, seeded());
	const preview = await mcpPreview(
		s.workspace,
		{ operation: "add", name: "added", server: { transport: "stdio", command: "npx" } },
		options(s),
	);

	const other = await mcpApply(
		s.workspace,
		{ operation: "add", name: "other", server: { transport: "stdio", command: "npx" } },
		preview.plan?.digest,
		options(s),
	);
	assert.equal(other.state, "refused");
	assert.equal(other.reason, "stale-plan");
	assert.match(other.message, /preview again/i);
	assert.equal(readFileSync(s.path, "utf8"), original);
});

test("an apply after the file changed on disk is refused, and the newer content is left untouched", async () => {
	const s = scratch();
	writeMcp(s, seeded());
	const request = { operation: "add" as const, name: "added", server: { transport: "stdio" as const, command: "npx" } };
	const preview = await mcpPreview(s.workspace, request, options(s));

	const changed = `${JSON.stringify({ mcpServers: { docs: { url: "https://from-the-terminal.example.com/mcp" } } }, null, 4)}\n`;
	writeFileSync(s.path, changed);

	const refused = await mcpApply(s.workspace, request, preview.plan?.digest, options(s));
	assert.equal(refused.state, "refused");
	assert.equal(refused.reason, "changed-on-disk");
	assert.equal(readFileSync(s.path, "utf8"), changed, "the newest content wins");
});

test("the same digest cannot be applied twice", async () => {
	const s = scratch();
	writeMcp(s, seeded());
	const request = { operation: "remove" as const, name: "docs" };
	const preview = await mcpPreview(s.workspace, request, options(s));

	const first = await mcpApply(s.workspace, request, preview.plan?.digest, options(s));
	assert.equal(first.state, "ok");
	const afterFirst = readFileSync(s.path, "utf8");

	const second = await mcpApply(s.workspace, request, preview.plan?.digest, options(s));
	assert.equal(second.state, "refused");
	assert.equal(second.reason, "stale-plan");
	assert.equal(readFileSync(s.path, "utf8"), afterFirst);
});

test("an invalid server config is refused with Pi's own reason, and nothing is written", async () => {
	const s = scratch();
	const original = writeMcp(s, seeded());

	const invalid: readonly { readonly server: Record<string, unknown>; readonly reason: RegExp }[] = [
		{ server: { transport: "stdio", command: "npx", args: [1] }, reason: /args must be an array of strings/ },
		{ server: { transport: "http", url: "https://api.example.com/mcp", headers: { Authorization: 3 } }, reason: /headers must map names to strings/ },
		{ server: { transport: "http" }, reason: /needs either "command" \(stdio\) or "url"/ },
		{ server: { transport: "sse", command: "npx" }, reason: /stdio|http/ },
		{ server: { transport: "stdio", command: "npx", timeout: 0 }, reason: /timeout must be a positive number/ },
	];
	for (const { server, reason } of invalid) {
		await assert.rejects(() => mcpPreview(s.workspace, { operation: "add", name: "added", server }, options(s)), reason);
	}

	// A name Pi would not accept is refused by the same rule, whichever operation asks.
	await assert.rejects(
		() => mcpPreview(s.workspace, { operation: "add", name: "not a name", server: { transport: "stdio", command: "npx" } }, options(s)),
		/invalid server name/,
	);
	await assert.rejects(() => mcpPreview(s.workspace, { operation: "remove", name: "not a name" }, options(s)), /invalid server name/);
	assert.equal(readFileSync(s.path, "utf8"), original);
});

test("a field the request names that this transport does not take is refused, not written", async () => {
	const s = scratch();
	const original = writeMcp(s, seeded());

	// `headers` belongs to http, `args` to stdio, and `oauth` is not part of the editable surface at all.
	await assert.rejects(
		() => mcpPreview(s.workspace, { operation: "add", name: "added", server: { transport: "stdio", command: "npx", headers: { A: "b" } } }, options(s)),
		/stdio transport does not take "headers"/,
	);
	await assert.rejects(
		() => mcpPreview(s.workspace, { operation: "update", name: "docs", server: { args: ["x"] } }, options(s)),
		/http transport does not take "args"/,
	);
	await assert.rejects(
		() => mcpPreview(s.workspace, { operation: "update", name: "filesystem", server: { oauth: {} } }, options(s)),
		/not a field this can write/,
	);
	assert.equal(readFileSync(s.path, "utf8"), original);
});

test("changing the transport drops the fields of the one it leaves behind", async () => {
	const s = scratch();
	writeMcp(s, {
		mcpServers: { filesystem: { command: "npx", args: ["-y", "pkg"], env: { API_KEY: ENV_SECRET }, exposure: "direct" } },
	});

	const request = { operation: "update" as const, name: "filesystem", server: { transport: "http" as const, url: "https://files.example.com/mcp" } };
	const preview = await mcpPreview(s.workspace, request, options(s));
	assert.equal(preview.state, "ok");
	assert.equal(preview.change?.after?.transport, "http");
	assert.equal(preview.change?.after?.command, null, "a stdio command means nothing on an http server");
	assert.deepEqual(preview.change?.after?.environment, []);

	const applied = await mcpApply(s.workspace, request, preview.plan?.digest, options(s));
	assert.equal(applied.state, "ok");
	const entry = serversOnDisk(s)["filesystem"] ?? {};
	assert.equal(entry["url"], "https://files.example.com/mcp");
	assert.equal("command" in entry, false);
	assert.equal("args" in entry, false);
	assert.equal("env" in entry, false);
	assert.equal(entry["exposure"], "direct", "a field that belongs to both transports is kept");
});

test("an operation this family does not know, and a name that is not a string, are refused", async () => {
	const s = scratch();
	const original = writeMcp(s, seeded());

	for (const operation of ["install", "ADD", "", 3, null]) {
		await assert.rejects(() => mcpPreview(s.workspace, { operation, name: "docs" }, options(s)), /add, update or remove/);
	}
	for (const name of ["", "   ", 3, null]) {
		await assert.rejects(() => mcpPreview(s.workspace, { operation: "remove", name }, options(s)), /name/);
	}
	assert.equal(readFileSync(s.path, "utf8"), original);
});

test("the websocket answers list, preview and apply, and an action it does not know comes back as an error", async () => {
	const s = scratch();
	writeMcp(s, seeded());
	const server = await startBridgeServer({ workspace: s.workspace, mcp: options(s) });
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	const answer = async (id: string, request: Record<string, unknown>): Promise<ServerMessage> => {
		const waiting = next(ws, (message) => "id" in message && message.id === id);
		ws.send(JSON.stringify({ id, ...request }));
		return await waiting;
	};
	try {
		await new Promise((resolve) => ws.on("open", resolve));

		const listed = await answer("m1", { kind: "mcp", action: "list" });
		assert.equal(listed.kind, "mcp");
		if (listed.kind === "mcp") {
			assert.equal(listed.action, "list");
			assert.deepEqual(listed.data.servers.map((entry) => entry.name), ["docs", "filesystem"]);
			assertNoSecrets(listed.data, "the listed servers");
		}

		const add = { operation: "add", name: "added", server: { transport: "stdio", command: "npx", env: { API_KEY: ADDED_ENV_SECRET } } };
		const preview = await answer("m2", { kind: "mcp", action: "preview", ...add });
		assert.equal(preview.kind, "mcp");
		const digest = preview.kind === "mcp" ? (preview.data.plan?.digest ?? "") : "";
		assert.match(digest, /^[0-9a-f]{64}$/);
		assertNoSecrets(preview, "the preview over the wire");

		const applied = await answer("m3", { kind: "mcp", action: "apply", ...add, digest });
		assert.equal(applied.kind, "mcp");
		if (applied.kind === "mcp") {
			assert.equal(applied.action, "apply");
			assert.equal(applied.data.state, "ok");
			assert.deepEqual(applied.data.servers.map((entry) => entry.name), ["added", "docs", "filesystem"]);
			assert.notEqual(applied.data.backup, null);
		}

		const unknown = await answer("m4", { kind: "mcp", action: "update" });
		assert.equal(unknown.kind, "error", "an action the bridge does not know must be answered");
	} finally {
		ws.close();
		await server.close();
	}
});
