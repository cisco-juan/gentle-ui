// The reviewer runner's bridge half, exercised against a fake `pi`.
//
// Not one test runs the real binary: the executable is a generated script whose interpreter is this
// process's own node, so no model is ever called and no credit is ever spent. The script records the
// argv it was handed and — like real `pi` — writes a session file into the agent home unless
// `--no-session` is among them, which is what makes "nothing was created there" a proof about the flag
// rather than about the fake staying quiet.

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import type { ReviewRunnerView, ServerMessage } from "@gentle-shell/protocol";
import { runReviewer } from "../src/reviewer.ts";
import { startBridgeServer } from "../src/server.ts";

/**
 * The fake provider-side binary, standing in for `pi`.
 *
 * It answers from `scenario.json` and appends every invocation to `calls.jsonl`, so a test asserts
 * both what the bridge asked for and what the run answered.
 */
const FAKE_SOURCE = `const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { dirname, join } = require("node:path");
const home = dirname(process.argv[1]);
const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(join(home, "scenario.json"), "utf8"));
const record = { args, pid: process.pid, childPid: null };
const agentHome = process.env.PI_CODING_AGENT_DIR;
if (!args.includes("--no-session") && agentHome) {
	mkdirSync(join(agentHome, "sessions"), { recursive: true });
	writeFileSync(join(agentHome, "sessions", "session.jsonl"), "{}\\n");
}
if (scenario.spawnChild === true) {
	const survivor = join(home, "survivor.txt");
	const script = "setTimeout(() => require('node:fs').writeFileSync(" + JSON.stringify(survivor) + ", 'alive'), 1500)";
	record.childPid = spawn(process.execPath, ["-e", script], { stdio: "ignore" }).pid;
}
appendFileSync(join(home, "calls.jsonl"), JSON.stringify(record) + "\\n");
const respond = () => {
	if (typeof scenario.stderr === "string") process.stderr.write(scenario.stderr);
	if (typeof scenario.stdout === "string") process.stdout.write(scenario.stdout);
	process.exitCode = typeof scenario.exit === "number" ? scenario.exit : 0;
};
if (typeof scenario.delayMs === "number" && scenario.delayMs > 0) setTimeout(respond, scenario.delayMs);
else respond();
`;

interface FakeScenario {
	readonly stdout?: string;
	readonly stderr?: string;
	readonly exit?: number;
	/** Keeps the fake alive this long, so a timeout has something to kill. */
	readonly delayMs?: number;
	/** A grandchild that writes a file 1.5 s later: only a tree kill stops it. */
	readonly spawnChild?: boolean;
}

interface FakeCall {
	readonly args: readonly string[];
	readonly pid: number;
	readonly childPid: number | null;
}

interface FakePi {
	readonly executable: string;
	/** Every invocation the fake recorded, in order; empty when it was never started. */
	calls(): readonly FakeCall[];
}

function fakePi(t: TestContext, scenario: FakeScenario): FakePi {
	const home = mkdtempSync(join(tmpdir(), "gentle-reviewer-"));
	const executable = join(home, "pi");
	const logPath = join(home, "calls.jsonl");
	writeFileSync(executable, `#!${process.execPath}\n${FAKE_SOURCE}`);
	chmodSync(executable, 0o755);
	writeFileSync(join(home, "scenario.json"), JSON.stringify(scenario));
	t.after(() => {
		// A run that outlived its own timeout must not outlive the test that proved it was killed.
		for (const call of recorded()) {
			terminate(call.pid);
			terminate(call.childPid);
		}
		rmSync(home, { recursive: true, force: true });
	});
	return { executable, calls: recorded };

	function recorded(): readonly FakeCall[] {
		if (!existsSync(logPath)) return [];
		return readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as FakeCall);
	}
}

function terminate(pid: number | null): void {
	if (pid === null || pid === 0) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone: that is the outcome these tests want.
	}
}

/** A throwaway directory that removes itself when the test ends. */
function scratch(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "gentle-reviewer-scratch-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

const MODEL = "openrouter/anthropic/claude-sonnet-4.5";
const CONTEXT = "- LENS review-reliability\nRead `src/App.tsx` and report the findings.";

test("the reviewer runs pi --print --no-session with the model and the context as argv", async (t) => {
	const pi = fakePi(t, { stdout: "verdict: no findings\n" });

	const result = await runReviewer(
		{ model: MODEL, context: CONTEXT },
		{ executable: pi.executable, env: { PI_CODING_AGENT_DIR: scratch(t) } },
	);

	assert.equal(result.text, "verdict: no findings");
	assert.equal(result.exitCode, 0);
	assert.equal(result.truncated, false);
	assert.equal(typeof result.durationMs, "number");
	// The whole argv, in order: `--` ends option parsing, so a context that begins with a dash is a
	// message and not a flag the binary would refuse.
	assert.deepEqual(pi.calls().length, 1);
	assert.deepEqual(pi.calls()[0]?.args, ["--print", "--no-session", "--model", MODEL, "--", CONTEXT]);
});

test("a failing exit code is an answer, and its stderr is what the panel reads", async (t) => {
	const pi = fakePi(t, { exit: 2, stderr: "no such model: openrouter/nope\n" });

	const result = await runReviewer(
		{ model: "openrouter/nope", context: CONTEXT },
		{ executable: pi.executable, env: { PI_CODING_AGENT_DIR: scratch(t) } },
	);

	assert.equal(result.exitCode, 2);
	assert.equal(result.text, "no such model: openrouter/nope");
});

test("a run that outlives its timeout is killed with its whole tree", async (t) => {
	const pi = fakePi(t, { delayMs: 60_000, spawnChild: true });

	await assert.rejects(
		runReviewer(
			{ model: MODEL, context: CONTEXT },
			{ executable: pi.executable, env: { PI_CODING_AGENT_DIR: scratch(t) }, timeoutMs: 400 },
		),
		/did not finish within 400 ms/,
	);

	// The grandchild would have written this 1.5 s after it started; a kill aimed at one pid only
	// would leave it running long enough to do so.
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	const survivor = join(dirname(pi.executable), "survivor.txt");
	assert.equal(existsSync(survivor), false, `${survivor} exists, so the process tree survived the kill`);
});

test("the captured verdict stops at the cap and says it was truncated", async (t) => {
	const pi = fakePi(t, { stdout: "x".repeat(5_000) });

	const result = await runReviewer(
		{ model: MODEL, context: CONTEXT },
		{ executable: pi.executable, env: { PI_CODING_AGENT_DIR: scratch(t) }, maxTextChars: 100 },
	);

	assert.equal(result.text.length, 100);
	assert.equal(result.truncated, true);
});

test("a reviewer run leaves no session behind in the agent home", async (t) => {
	const pi = fakePi(t, { stdout: "verdict: no findings\n" });
	const agentHome = scratch(t);

	await runReviewer({ model: MODEL, context: CONTEXT }, { executable: pi.executable, env: { PI_CODING_AGENT_DIR: agentHome } });

	// The fake writes `sessions/session.jsonl` whenever `--no-session` is missing, which is what real
	// `pi` does too: an empty home is the assertion that the run never had a session to save.
	assert.deepEqual(readdirSync(agentHome), []);
});

test("an empty model is refused before any process exists", async (t) => {
	const pi = fakePi(t, { stdout: "verdict: no findings\n" });

	await assert.rejects(
		runReviewer({ model: "   ", context: CONTEXT }, { executable: pi.executable, env: { PI_CODING_AGENT_DIR: scratch(t) } }),
		/needs a model/,
	);
	assert.deepEqual(pi.calls(), []);
});

/** Resolve with the first bridge message that matches, so tests never depend on message order. */
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

test("the bridge routes reviewer-run, and a refused run keeps the error envelope", async (t) => {
	const pi = fakePi(t, { stdout: "verdict: no findings\n" });
	const agentHome = scratch(t);
	const server = await startBridgeServer({
		workspace: scratch(t),
		reviewer: { executable: pi.executable, env: { PI_CODING_AGENT_DIR: agentHome } },
	});
	t.after(() => server.close());

	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	t.after(() => ws.close());
	await new Promise((resolve) => ws.once("open", resolve));

	ws.send(JSON.stringify({ kind: "review", id: "run-1", action: "reviewer-run", model: MODEL, context: CONTEXT }));
	const answer = await next(ws, (message) => {
		return "id" in message && message.id === "run-1";
	});
	assert.equal(answer.kind, "review");
	assert.equal(answer.kind === "review" && answer.action, "reviewer-run");
	const data = (answer as { readonly data: ReviewRunnerView }).data;
	assert.equal(data.text, "verdict: no findings");
	assert.equal(data.exitCode, 0);
	assert.equal(data.truncated, false);
	assert.deepEqual(pi.calls()[0]?.args, ["--print", "--no-session", "--model", MODEL, "--", CONTEXT]);

	ws.send(JSON.stringify({ kind: "review", id: "run-2", action: "reviewer-run", model: "", context: CONTEXT }));
	const refused = await next(ws, (message) => {
		return "id" in message && message.id === "run-2";
	});
	assert.equal(refused.kind, "error");
	assert.match(refused.kind === "error" ? refused.message : "", /needs a model/);
});
