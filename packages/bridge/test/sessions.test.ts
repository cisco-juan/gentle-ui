import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listSessions } from "../src/sessions.ts";

const BASE_SECONDS = 1_700_000_000;

/**
 * Build a scratch session root. Lines may be objects (serialised) or raw strings, so a test can
 * plant a truncated line exactly the way a half-written session file looks on disk.
 */
function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "gentle-sessions-"));
	mkdirSync(join(root, "--work-beta--"), { recursive: true });
	mkdirSync(join(root, "--work-gamma--"), { recursive: true });

	writeSession(
		join(root, "older.jsonl"),
		[
			{ type: "session", version: 3, id: "older", timestamp: "2026-01-01T10:00:00.000Z", cwd: "/work/alpha" },
			{ type: "model_change", id: "e1", parentId: "older", timestamp: "2026-01-01T10:00:01.000Z", provider: "anthropic", modelId: "claude-sonnet" },
			{ type: "session_info", id: "e2", parentId: "e1", timestamp: "2026-01-01T10:00:02.000Z", name: "Named thread" },
			{
				type: "message",
				id: "e3",
				parentId: "e2",
				timestamp: "2026-01-01T10:00:03.000Z",
				message: { role: "user", content: [{ type: "text", text: "this message must not become the title" }], timestamp: 1 },
			},
		],
		BASE_SECONDS + 1_000,
	);

	writeSession(
		join(root, "--work-beta--", "newer.jsonl"),
		[
			{ type: "session", version: 3, id: "newer", timestamp: "2026-01-02T10:00:00.000Z", cwd: "/work/beta" },
			{ type: "message", id: "f1", parentId: null, timestamp: "2026-01-02T10:00:01.000Z", message: { role: "system", content: "you are an agent", timestamp: 1 } },
			{
				type: "message",
				id: "f2",
				parentId: "f1",
				timestamp: "2026-01-02T10:00:02.000Z",
				message: { role: "user", content: [{ type: "text", text: LONG_PROMPT }], timestamp: 2 },
			},
		],
		BASE_SECONDS + 2_000,
	);

	writeSession(
		join(root, "--work-gamma--", "corrupt.jsonl"),
		[
			{ type: "session", version: 3, id: "corrupt", timestamp: "2026-01-03T10:00:00.000Z", cwd: "/work/gamma" },
			'{"type":"message","id":"g1","message":{"role":"user","content":[{"type":"te',
			{
				type: "message",
				id: "g2",
				parentId: null,
				timestamp: "2026-01-03T10:00:02.000Z",
				message: { role: "user", content: "fix the build", timestamp: 2 },
			},
		],
		BASE_SECONDS + 3_000,
	);

	writeSession(
		join(root, "header-only.jsonl"),
		[{ type: "session", version: 3, id: "header", timestamp: "2026-01-04T10:00:00.000Z" }],
		BASE_SECONDS + 500,
	);

	return root;
}

const LONG_PROMPT =
	"Refactor the session index so the sidebar can list every thread without parsing whole files twice";

function writeSession(path: string, lines: readonly unknown[], mtimeSeconds: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const body = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
	writeFileSync(path, `${body}\n`);
	utimesSync(path, mtimeSeconds, mtimeSeconds);
}

test("lists sessions newest first with derived titles, cwds and mtimes", async () => {
	const root = fixtureRoot();
	try {
		const items = await listSessions({ sessionDir: root });

		assert.deepEqual(
			items.map((item) => item.title),
			["fix the build", LONG_PROMPT.slice(0, 80), "Named thread", "header-only"],
		);
		assert.deepEqual(
			items.map((item) => item.cwd),
			["/work/gamma", "/work/beta", "/work/alpha", ""],
		);
		assert.deepEqual(
			items.map((item) => item.updatedAt),
			[BASE_SECONDS + 3_000, BASE_SECONDS + 2_000, BASE_SECONDS + 1_000, BASE_SECONDS + 500].map((seconds) => seconds * 1_000),
		);
		assert.equal(items[2]?.model, "claude-sonnet");
		assert.equal(items[3]?.model, undefined);
		for (const item of items) assert.ok(item.path.endsWith(".jsonl"));

		// `sessionDir` wins over the default roots, and the limit still trims the newest entries.
		const limited = await listSessions({ sessionDir: root, defaultRoots: [join(root, "--work-beta--")], limit: 2 });
		assert.deepEqual(
			limited.map((item) => item.title),
			["fix the build", LONG_PROMPT.slice(0, 80)],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
