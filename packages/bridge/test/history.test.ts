import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pageHistory, readHistoryPage } from "../src/history.ts";

/** One `message` line, in the shape Pi writes into a session file. */
function line(id: string, message: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", id, parentId: null, timestamp: "2026-01-01T10:00:00.000Z", message };
}

function user(id: string, text: string): Record<string, unknown> {
	return line(id, { role: "user", content: [{ type: "text", text }], timestamp: 1 });
}

function assistant(id: string, content: readonly unknown[], model = "claude-sonnet"): Record<string, unknown> {
	return line(id, { role: "assistant", content, model, timestamp: 2 });
}

function toolResult(id: string, callId: string, text: string, isError = false): Record<string, unknown> {
	return line(id, {
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp: 3,
	});
}

/** Ten user turns, so a page boundary is easy to state. */
function tenTurns(): unknown[] {
	const lines: unknown[] = [];
	for (let index = 0; index < 10; index += 1) lines.push(user(`u${index}`, `question ${index}`));
	return lines;
}

test("the first page is the newest turns, and the cursor walks backwards to the start", () => {
	const lines = tenTurns();

	const first = pageHistory(lines, { limit: 4 });
	assert.deepEqual(first.entries.map((entry) => entry.id), ["u6", "u7", "u8", "u9"]);
	assert.equal(first.before, 6);
	assert.equal(first.total, 10);

	const second = pageHistory(lines, { before: first.before ?? 0, limit: 4 });
	assert.deepEqual(second.entries.map((entry) => entry.id), ["u2", "u3", "u4", "u5"]);
	assert.equal(second.before, 2);

	const third = pageHistory(lines, { before: second.before ?? 0, limit: 4 });
	assert.deepEqual(third.entries.map((entry) => entry.id), ["u0", "u1"]);
	assert.equal(third.before, null);
});

test("a page defaults to the forty newest turns", () => {
	const lines: unknown[] = [];
	for (let index = 0; index < 45; index += 1) lines.push(user(`u${index}`, `question ${index}`));

	const page = pageHistory(lines);
	assert.equal(page.entries.length, 40);
	assert.equal(page.entries[0]?.id, "u5");
	assert.equal(page.entries[39]?.id, "u44");
	assert.equal(page.before, 5);
	assert.equal(page.total, 45);
});

test("a tool result belongs to the assistant turn that called the tool", () => {
	const page = pageHistory([
		user("u1", "list the files"),
		assistant("a1", [
			{ type: "thinking", thinking: "I should look first." },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
		]),
		toolResult("r1", "call-1", "README.md\n"),
		assistant("a2", [{ type: "text", text: "One file." }]),
	]);

	assert.equal(page.total, 3);
	assert.deepEqual(page.entries.map((entry) => entry.id), ["u1", "a1", "a2"]);

	const call = page.entries[1];
	assert.equal(call?.role, "assistant");
	if (call?.role !== "assistant") return;
	assert.equal(call.text, "");
	assert.equal(call.thinking, "I should look first.");
	assert.equal(call.model, "claude-sonnet");
	assert.deepEqual(call.tools, [
		{ id: "call-1", name: "bash", input: { command: "ls" }, output: "README.md\n", isError: false },
	]);

	const answer = page.entries[2];
	assert.equal(answer?.role === "assistant" ? answer.text : null, "One file.");
	assert.equal(answer?.role === "assistant" ? answer.tools.length : -1, 0);
});

test("a tool whose result never arrived is still shown, with nothing to report", () => {
	const page = pageHistory([assistant("a1", [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }])]);

	const entry = page.entries[0];
	assert.equal(entry?.role, "assistant");
	if (entry?.role !== "assistant") return;
	assert.deepEqual(entry.tools, [{ id: "call-1", name: "bash", input: {}, output: "", isError: false }]);
});

test("a failed tool keeps the flag the session file recorded", () => {
	const page = pageHistory([
		assistant("a1", [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "false" } }]),
		toolResult("r1", "call-1", "Command exited with code 1", true),
	]);

	const entry = page.entries[0];
	if (entry?.role !== "assistant") return assert.fail("the tool call should have produced an assistant entry");
	assert.equal(entry.tools[0]?.isError, true);
	assert.equal(entry.tools[0]?.output, "Command exited with code 1");
});

test("tool arguments arrive as an object or as the JSON string the file holds", () => {
	const page = pageHistory([
		assistant("a1", [
			{ type: "toolCall", id: "c1", name: "read", arguments: '{"path":"a.ts"}' },
			{ type: "toolCall", id: "c2", name: "bash", arguments: "ls -la" },
		]),
	]);

	const entry = page.entries[0];
	if (entry?.role !== "assistant") return assert.fail("the tool calls should have produced an assistant entry");
	assert.deepEqual(entry.tools[0]?.input, { path: "a.ts" });
	assert.equal(entry.tools[1]?.input, "ls -la");
});

test("a turn with no text, no thinking and no tools is not a turn", () => {
	const page = pageHistory([
		{ type: "session", id: "s1", cwd: "/work" },
		{ type: "model_change", id: "m1", provider: "anthropic", modelId: "claude-sonnet" },
		{ type: "custom", id: "c1", customType: "gentle-pi.session-profile/v1", data: {} },
		user("u-empty", ""),
		user("u-space", "   "),
		assistant("a-empty", [{ type: "text", text: " \n " }]),
		line("sys", { role: "system", content: "you are an agent" }),
		user("u1", "hello"),
	]);

	assert.equal(page.total, 1);
	assert.deepEqual(page.entries.map((entry) => entry.id), ["u1"]);
});

test("a malformed line does not lose the rest of the transcript", () => {
	const page = pageHistory(['{"type":"message","id":"broken"', ...tenTurns()]);
	assert.equal(page.total, 10);
	assert.equal(page.entries[9]?.id, "u9");
});

test("a session with no turns has no page and no cursor", () => {
	assert.deepEqual(pageHistory([]), { entries: [], before: null, total: 0 });
	assert.deepEqual(pageHistory([user("u1", "hello")], { before: 0 }), { entries: [], before: null, total: 1 });
});

/** Write a scratch session file under its own session root, so the reader has a directory to trust. */
function scratchSession(lines: readonly unknown[]): { root: string; path: string } {
	const root = mkdtempSync(join(tmpdir(), "gentle-history-"));
	const path = join(root, "--work--", "session.jsonl");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return { root, path };
}

test("reads a page from the session file the bridge listed", async () => {
	const { root, path } = scratchSession(tenTurns());
	try {
		const page = await readHistoryPage(path, { sessionDir: root, limit: 2 });
		assert.deepEqual(page.entries.map((entry) => entry.id), ["u8", "u9"]);
		assert.equal(page.before, 8);
		assert.equal(page.total, 10);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("refuses a session path outside the directory the bridge lists", async () => {
	const root = mkdtempSync(join(tmpdir(), "gentle-history-root-"));
	const outside = scratchSession([user("u1", "hello")]);
	try {
		await assert.rejects(readHistoryPage(outside.path, { sessionDir: root }), /session directory/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside.root, { recursive: true, force: true });
	}
});

test("refuses a path that is not a session file", async () => {
	const { root } = scratchSession([user("u1", "hello")]);
	try {
		await assert.rejects(readHistoryPage(join(root, "--work--"), { sessionDir: root }), /session file/);
		await assert.rejects(readHistoryPage(join(root, "missing.jsonl"), { sessionDir: root }), /session file/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
