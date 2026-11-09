// The native review panel's bridge half, exercised against a fake `gentle-ai`.
//
// Not one test runs the real provider: the binary is a generated script whose interpreter is this
// process's own node, so the suite never costs a model call and never writes review authority. The
// script records every argv it receives, which is how the suite proves that a START always carries
// `--consent relay` and that a consent answer replays the exact invocation the provider handed out.
//
// Fixtures under `test/fixtures/review/` are recorded answers of `gentle-ai review …` from this
// machine, with the repository path replaced by `/work/repo`.

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { ServerMessage } from "@gentle-shell/protocol";
import { startBridgeServer } from "../src/server.ts";
import {
	REVIEW_CONTRACT,
	answerConsent,
	reviewAssess,
	reviewModeStatus,
	reviewStart,
	reviewStatus,
	splitInvocation,
	type ReviewStatusView,
} from "../src/review.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "review");

/**
 * The fake provider.
 *
 * It answers by verb (`"review status"`, `"review status:lineage"`, `"review start"`, …) from
 * `scenario.json`, and appends every argv to `calls.jsonl`, so a test can assert both what the
 * bridge asked for and what it forwarded.
 */
const FAKE_SOURCE = `const { appendFileSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const home = dirname(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(join(home, "calls.jsonl"), JSON.stringify({ args }) + "\\n");
const scenario = JSON.parse(readFileSync(join(home, "scenario.json"), "utf8"));
const verb = args.slice(0, 2).join(" ");
const key = args.some((arg) => arg.startsWith("--lineage")) ? verb + ":lineage" : verb;
const entry = scenario[key] || scenario[verb] || { exit: 0 };
const respond = () => {
	if (typeof entry.stderr === "string") process.stderr.write(entry.stderr);
	if (typeof entry.fixture === "string") process.stdout.write(readFileSync(join(${JSON.stringify(FIXTURES)}, entry.fixture), "utf8"));
	if (typeof entry.stdout === "string") process.stdout.write(entry.stdout);
	process.exitCode = typeof entry.exit === "number" ? entry.exit : 0;
};
if (typeof entry.delayMs === "number" && entry.delayMs > 0) setTimeout(respond, entry.delayMs);
else respond();
`;

interface FakeResponse {
	readonly fixture?: string;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly exit?: number;
	readonly delayMs?: number;
}

type FakeScenario = Readonly<Record<string, FakeResponse>>;

interface FakeCli {
	readonly binary: string;
	set(scenario: FakeScenario): void;
	/** Every argv the fake received, in order; empty when it was never started. */
	calls(): readonly (readonly string[])[];
}

function fakeCli(t: TestContext, scenario: FakeScenario): FakeCli {
	const home = mkdtempSync(join(tmpdir(), "gentle-review-cli-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const binary = join(home, "gentle-ai");
	const scenarioPath = join(home, "scenario.json");
	const logPath = join(home, "calls.jsonl");
	writeFileSync(binary, `#!${process.execPath}\n${FAKE_SOURCE}`);
	chmodSync(binary, 0o755);
	writeFileSync(scenarioPath, JSON.stringify(scenario));
	return {
		binary,
		set(next) {
			writeFileSync(scenarioPath, JSON.stringify(next));
		},
		calls() {
			if (!existsSync(logPath)) return [];
			return readFileSync(logPath, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => (JSON.parse(line) as { args: readonly string[] }).args);
		},
	};
}

/** A throwaway directory that removes itself when the test ends. */
function scratch(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "gentle-review-repo-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function git(root: string, ...args: readonly string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

/** A repository with one commit, so it is a review authority root and not a bare directory. */
function repository(t: TestContext): string {
	const root = scratch(t);
	git(root, "init", "--initial-branch=main", "--quiet");
	git(root, "config", "user.email", "tests@gentle-shell.example");
	git(root, "config", "user.name", "Gentle Shell tests");
	git(root, "config", "commit.gpgsign", "false");
	writeFileSync(join(root, "base.txt"), "one\ntwo\n");
	git(root, "add", "base.txt");
	git(root, "commit", "--message", "base", "--quiet");
	return root;
}

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

/** The start tokens a recorded status hands out, verbatim. */
function tokensOf(name: string): string[] {
	const recorded = JSON.parse(fixture(name)) as {
		next_transition: { execute: { arguments: readonly { token: string }[] } };
	};
	return recorded.next_transition.execute.arguments.map((entry) => entry.token);
}

/** The invocation a recorded consent envelope offers for one answer. */
function invocationOf(answer: "granted" | "declined"): string {
	const recorded = JSON.parse(fixture("consent.json")) as {
		choices: readonly { answer: string; invocation: string }[];
	};
	const choice = recorded.choices.find((entry) => entry.answer === answer);
	assert.ok(choice !== undefined, `the consent fixture has no "${answer}" choice`);
	return choice.invocation;
}

/** Give the repository one recorded lineage directory, the artefact a panel reads to name it. */
function lineageDir(root: string, lineage: string): string {
	const gitDir = git(root, "rev-parse", "--absolute-git-dir").trim();
	const dir = join(gitDir, "gentle-ai", "review-transactions", "v2", lineage);
	mkdirSync(dir, { recursive: true });
	return dir;
}

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

test("status asks the provider first and keeps the tokens its start transition carries", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review status": { fixture: "status-execute.json" } });

	const view = await reviewStatus(root, { binary: cli.binary });

	assert.equal(view.state, "ok");
	assert.equal(view.emptiness, "no-authority");
	assert.equal(view.repository, root);
	assert.equal(view.contract, REVIEW_CONTRACT);
	assert.equal(view.applicability, "unrelated");
	assert.equal(view.action, "start");
	assert.equal(view.projection, "workspace");
	assert.equal(view.targetIdentity, "sha256:0db81e730faea096ad63689d6b061ab6385a82b96ee837a2ed50cfb07c0b9eaf");
	assert.deepEqual(view.changedPaths, ["packages/bridge/src/review.ts", "packages/bridge/test/review.test.ts"]);
	assert.equal(view.authority, null);
	assert.equal(view.frozen, null);
	assert.equal(view.transition?.kind, "execute");
	assert.equal(view.transition?.reasonCode, "fresh_target_ready");
	assert.deepEqual(view.transition?.execute?.tokens, tokensOf("status-execute.json"));
	assert.equal(view.transition?.execute?.operation, "review.start");
	assert.equal(view.transition?.execute?.lineageId, "review-b005087be055cc9b");
	assert.equal(view.raw, null);
	assert.deepEqual(cli.calls(), [
		["review", "status", "--contract", REVIEW_CONTRACT, "--cwd", root, "--projection", "workspace", "--next-transition"],
	]);
});

test("status keeps a collect transition, whose captures belong to phase two", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review status": { fixture: "status-collect.json" } });

	const view = await reviewStatus(root, { binary: cli.binary });

	assert.equal(view.emptiness, null);
	assert.deepEqual(view.authority, {
		version: "compact-v2",
		lineageId: "review-b005087be055cc9b",
		state: "reviewing",
		generation: 1,
		revision: "sha256:4ffb06712a51a7eded57a27df99d873a1aeb2718467b56ad195b6007a41bef5d",
	});
	assert.deepEqual(view.frozen, {
		tier: "medium",
		changedLines: 41,
		correctionBudget: 1,
		changedPathManifestDigest: "sha256:78196da0104a3ee38b8ea776e092b97e27a2a6a1479568c5d232a6ad552f190e",
	});
	assert.equal(view.authorityStale, false);
	assert.equal(view.transition?.kind, "collect");
	assert.equal(view.transition?.reasonCode, "reviewer_results_required");
	assert.equal(view.transition?.execute, null);
	assert.deepEqual(
		view.transition?.collect.map((input) => input.captureOperation),
		["review.capture-result"],
	);
	assert.equal(view.transition?.collect[0]?.name, "reviewer_result");
});

test("status keeps a stop transition and its reason code verbatim", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review status": { fixture: "status-stop.json" } });

	const view = await reviewStatus(root, { binary: cli.binary });

	assert.equal(view.transition?.kind, "stop");
	assert.equal(view.transition?.reasonCode, "rdd_disabled");
	assert.equal(view.transition?.execute, null);
	assert.deepEqual(view.transition?.collect, []);
	assert.equal(view.authority, null);
});

test("status reads the authority a lineage reports, which the plain answer never carries", async (t) => {
	const root = repository(t);
	lineageDir(root, "review-b005087be055cc9b");
	const cli = fakeCli(t, {
		"review status": { fixture: "status-no-authority.json" },
		"review status:lineage": { fixture: "status-collect.json" },
	});

	const view = await reviewStatus(root, { binary: cli.binary });

	assert.equal(view.authority?.lineageId, "review-b005087be055cc9b");
	assert.equal(view.authority?.state, "reviewing");
	assert.equal(view.authorityStale, false);
	assert.equal(view.transition?.kind, "collect");
	const calls = cli.calls();
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1], [
		"review",
		"status",
		"--contract",
		REVIEW_CONTRACT,
		"--cwd",
		root,
		"--projection",
		"workspace",
		"--lineage",
		"review-b005087be055cc9b",
		"--next-transition",
	]);
});

/** Inventory digest the provider issues for a tree with untracked files. */
const UNTRACKED_INVENTORY = "sha256:cc090fa97db9cb7239a0572b1c12c94ecb94fe5417ee421e78337b49f8484926";

/**
 * The recorded shape of status when untracked files exist: a collect transition whose arguments are
 * the provider's own intended-untracked selection binding. `paths` may be invalid on purpose.
 */
function untrackedStatus(paths: readonly string[], inventory: string | null = UNTRACKED_INVENTORY): string {
	const argumentsList: { name: string; value: string }[] = [
		{ name: "target_identity", value: "sha256:7eca20bca7ed7bc3be1455aec351ca8b6817272fb48d95771aa7936a6efd1720" },
		{ name: "projection", value: "workspace" },
		{ name: "base_tree", value: "005217268b4680838d10ccedebae0571182a64d9" },
		{ name: "candidate_tree", value: "005217268b4680838d10ccedebae0571182a64d9" },
		{ name: "eligible_paths_json", value: JSON.stringify(paths) },
	];
	if (inventory !== null) argumentsList.push({ name: "expected_untracked_inventory", value: inventory });

	return JSON.stringify({
		schema: "gentle-ai.review-integration.status/v2",
		contract: REVIEW_CONTRACT,
		operation: "review.status",
		applicability: "unrelated",
		action: "start",
		target_identity: "sha256:7eca20bca7ed7bc3be1455aec351ca8b6817272fb48d95771aa7936a6efd1720",
		projection: { projection: "workspace", paths: [] },
		eligible_untracked_inventory: UNTRACKED_INVENTORY,
		next_transition: {
			kind: "collect",
			reason_code: "intended_untracked_selection_required",
			collect: {
				inputs: [
					{
						name: "intended_untracked_selection",
						schema: "gentle-ai.review-intended-untracked-selection/v1",
						capture_operation: "external.select_intended_untracked",
						arguments: argumentsList,
					},
				],
			},
		},
	});
}

test("status relays the provider's own untracked selection as assess tokens", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review status": { stdout: untrackedStatus(["apps/desktop/src/new.ts", "docs/notes.md"]) } });

	const view = await reviewStatus(root, { binary: cli.binary });

	assert.equal(view.transition?.reasonCode, "intended_untracked_selection_required");
	assert.deepEqual(view.untracked, {
		inventory: UNTRACKED_INVENTORY,
		paths: ["apps/desktop/src/new.ts", "docs/notes.md"],
		tokens: [
			"--untracked-scope=select",
			`--expected-untracked-inventory=${UNTRACKED_INVENTORY}`,
			"--intended-untracked=apps/desktop/src/new.ts",
			"--intended-untracked=docs/notes.md",
		],
	});
});

test("a status selection without a usable inventory and paths is not offered", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review status": { stdout: untrackedStatus(["../escape.ts"]) } });

	const escaped = await reviewStatus(root, { binary: cli.binary });
	assert.equal(escaped.untracked, null);

	cli.set({ "review status": { stdout: untrackedStatus(["docs/notes.md"], null) } });
	const missing = await reviewStatus(root, { binary: cli.binary });
	assert.equal(missing.untracked, null);

	cli.set({ "review status": { fixture: "status-execute.json" } });
	const none = await reviewStatus(root, { binary: cli.binary });
	assert.equal(none.untracked, null);
});

test("status keeps the raw text when the answer is not the negotiated JSON", async (t) => {
	const root = repository(t);
	const raw = "review status: the provider printed prose instead\n";
	const cli = fakeCli(t, { "review status": { stdout: raw } });

	const view = await reviewStatus(root, { binary: cli.binary });

	assert.equal(view.state, "unreadable");
	assert.equal(view.raw, raw);
	assert.match(view.message, /not the JSON/);
	assert.equal(view.transition, null);
	assert.equal(view.authority, null);
});

test("a status whose start transition carries no usable tokens is refused, never offered", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, {
		"review status": {
			stdout: JSON.stringify({
				schema: "gentle-ai.review-integration.status/v2",
				applicability: "unrelated",
				action: "start",
				target_identity: "sha256:abc",
				projection: { projection: "workspace", paths: [] },
				next_transition: { kind: "execute", reason_code: "fresh_target_ready", execute: { arguments: [] } },
			}),
		},
	});

	const view = await reviewStatus(root, { binary: cli.binary });

	assert.equal(view.state, "unreadable");
	assert.match(view.message, /tokens/);
	assert.equal(view.transition, null);
});

test("assess reports the risk tier, why, and whether a review is owed", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review assess": { fixture: "assess.json" } });

	const view = await reviewAssess(root, { binary: cli.binary });

	assert.equal(view.risk, "medium");
	assert.deepEqual(view.reasons, [
		{ code: "executable_change", path: "packages/bridge/src/review.ts" },
		{ code: "public_contract_change", path: null },
	]);
	assert.equal(view.changedPaths, 2);
	assert.equal(view.changedLines, 41);
	assert.equal(view.candidateKind, "current-changes");
	assert.equal(view.candidateConsumed, false);
	assert.equal(view.reviewDue, false);
	assert.equal(view.reviewDueReason, "under_budget");
	assert.deepEqual(cli.calls(), [["review", "assess", "--cwd", root, "--json"]]);
});

test("mode reports the effective switch and which source decided it", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review mode": { fixture: "mode.json" } });

	const view = await reviewModeStatus(root, { binary: cli.binary });

	assert.deepEqual(view, {
		global: "on",
		cloneLocal: "off",
		effective: "off",
		source: "clone_local",
		revision: "sha256:6f2348017329fd5a96c65509735324539ed1e90656dfe107372bc3ab174e603f",
	});
	assert.deepEqual(cli.calls(), [["review", "mode", "status", "--cwd", root, "--json"]]);
});

test("start refuses a token that points the review at another workspace", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review start": { fixture: "consent.json" } });

	await assert.rejects(
		reviewStart(root, [`--cwd=${join(scratch(t), "elsewhere")}`], { binary: cli.binary }),
		/targets a different workspace/,
	);
	assert.deepEqual(cli.calls(), [], "the provider must not run for a refused token");
});

test("start refuses an empty token list without starting the provider", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review start": { fixture: "consent.json" } });

	await assert.rejects(reviewStart(root, [], { binary: cli.binary }), /needs the tokens its status transition provided/);
	assert.deepEqual(cli.calls(), []);
});

test("start relays consent and forwards the provider's tokens verbatim", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review start": { fixture: "consent.json" } });
	// The recorded transition names the fixture's repository; a real one names the workspace it runs in.
	const tokens = tokensOf("status-execute.json").map((token) =>
		token.startsWith("--cwd=") ? `--cwd=${root}` : token,
	);

	const view = await reviewStart(root, tokens, { binary: cli.binary });

	assert.equal(view.outcome, "consent");
	assert.equal(view.lineageId, "");
	assert.deepEqual(view.consent, {
		schema: "gentle-ai.review-integration.consent/v1",
		blocking: true,
		targetIdentity: "sha256:0db81e730faea096ad63689d6b061ab6385a82b96ee837a2ed50cfb07c0b9eaf",
		projection: "workspace",
		riskLevel: "medium",
		changedFiles: 2,
		changedLines: 41,
		headline: "Gentle AI can review this change before you call it done.",
		reason: "Review can help detect regressions in these changes.",
		value: "Reviewing takes a little longer and makes the result safer.",
		riskEvidence: [
			"this change is not purely passive documentation, so it gets one consolidated review.",
			"an executable change in packages/bridge/src/review.ts",
		],
		choices: [
			{
				answer: "granted",
				label: "Review this change",
				effect: "Reviews only this change; later medium- or high-risk changes ask again, and delivery needs separate approval.",
				invocation: invocationOf("granted"),
			},
			{
				answer: "declined",
				label: "Skip this time",
				effect: "Skips only this change; no review record is created, and future reviews stay enabled.",
				invocation: invocationOf("declined"),
			},
		],
		offPath: {
			note: "To turn reviews off for good, run 'gentle-ai review mode disable'.",
			command: "gentle-ai review mode disable",
		},
	});
	assert.deepEqual(cli.calls(), [["review", "start", ...tokens, "--consent", "relay"]]);
});

test("start refuses a token that would answer consent on the caller's behalf", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review start": { fixture: "consent.json" } });

	await assert.rejects(
		reviewStart(root, [`--cwd=${root}`, "--consent=granted"], { binary: cli.binary }),
		/must not answer consent/,
	);
	assert.deepEqual(cli.calls(), []);
});

test("consent replay refuses a forged invocation and never starts it", async (t) => {
	const cli = fakeCli(t, { "review start": { fixture: "start.json" } });

	for (const forged of [
		"rm -rf /work/repo",
		"sh -c 'gentle-ai review start --consent granted'",
		"/usr/local/bin/gentle-ai review start --consent granted",
	]) {
		await assert.rejects(answerConsent(forged, { binary: cli.binary }), /does not start with the resolved review binary/);
	}
	assert.deepEqual(cli.calls(), []);
});

test("consent replay refuses an invocation that does not answer consent", async (t) => {
	const cli = fakeCli(t, { "review start": { fixture: "start.json" } });
	const unanswered = invocationOf("granted").replace(" --consent granted", "");

	await assert.rejects(answerConsent(unanswered, { binary: cli.binary }), /does not answer consent/);
	await assert.rejects(
		answerConsent(`${invocationOf("granted")} --consent relay`, { binary: cli.binary }),
		/answers consent more than once/,
	);
	assert.deepEqual(cli.calls(), []);
});

test("consent replay runs the chosen invocation and reports the started lineage", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review start": { fixture: "start.json" } });

	const view = await answerConsent(invocationOf("granted"), { binary: cli.binary, cwd: root });

	assert.equal(view.outcome, "started");
	assert.equal(view.lineageId, "review-b005087be055cc9b");
	assert.equal(view.state, "reviewing");
	assert.equal(view.riskLevel, "medium");
	assert.deepEqual(view.selectedLenses, ["review-reliability"]);
	assert.equal(view.changedFiles, 2);
	assert.equal(view.changedLines, 41);
	assert.equal(view.correctionBudget, 1);
	assert.equal(view.consent, null);
	const calls = cli.calls();
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]?.slice(0, 2), ["review", "start"]);
	assert.deepEqual(calls[0]?.slice(-2), ["--consent", "granted"]);
});

test("consent replay reports a declined change without a lineage", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review start": { fixture: "start-declined.json" } });

	const view = await answerConsent(invocationOf("declined"), { binary: cli.binary, cwd: root });

	assert.equal(view.outcome, "declined");
	assert.equal(view.lineageId, "");
	assert.match(view.message, /skipped/i);
	assert.deepEqual(cli.calls()[0]?.slice(-2), ["--consent", "declined"]);
});

test("a failing provider surfaces its exit code and its stderr", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review status": { stderr: "the provider refused this repository\n", exit: 2 } });

	await assert.rejects(reviewStatus(root, { binary: cli.binary }), (error: Error) => {
		assert.match(error.message, /review status failed \(exit 2\)/);
		assert.match(error.message, /the provider refused this repository/);
		return true;
	});
});

test("a failing provider that explains itself in a failure envelope is quoted from it", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, {
		"review status": {
			fixture: "status-failure.json",
			stderr: "Error: The requested review integration contract is not supported. [unsupported_contract]\n",
			exit: 1,
		},
	});

	await assert.rejects(reviewStatus(root, { binary: cli.binary }), (error: Error) => {
		assert.match(error.message, /The requested review integration contract is not supported\./);
		assert.match(error.message, /unsupported_contract/);
		return true;
	});
});

test("a missing review binary is an error that names the path", async (t) => {
	const root = repository(t);
	const missing = join(root, "no-such-bin", "gentle-ai");

	await assert.rejects(reviewStatus(root, { binary: missing }), (error: Error) => {
		assert.match(error.message, /does not exist/);
		assert.ok(error.message.includes(missing));
		return true;
	});
});

test("a relative binary path is refused, because a PATH lookup is not an identity", async (t) => {
	const root = repository(t);

	await assert.rejects(reviewStatus(root, { binary: "gentle-ai" }), /absolute/);
});

test("a workspace that is not a repository is an empty state that never runs the provider", async (t) => {
	const root = scratch(t);
	const cli = fakeCli(t, { "review status": { fixture: "status-execute.json" } });

	const view = await reviewStatus(root, { binary: cli.binary });

	assert.equal(view.state, "empty");
	assert.equal(view.emptiness, "not-a-repository");
	assert.match(view.message, /not a git repository/);
	assert.equal(view.transition, null);
	assert.deepEqual(cli.calls(), []);
});

test("a repository the provider has no authority for is an honest empty authority", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review status": { fixture: "status-no-authority.json" } });

	const view = await reviewStatus(root, { binary: cli.binary });

	assert.equal(view.state, "ok");
	assert.equal(view.emptiness, "no-authority");
	assert.equal(view.authority, null);
	assert.deepEqual(view.transition?.execute?.tokens, tokensOf("status-no-authority.json"));
	assert.deepEqual(view.changedPaths, ["packages/bridge/src/review.ts"]);
});

test("a hung provider is stopped by the timeout instead of hanging the panel", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review status": { fixture: "status-execute.json", delayMs: 5_000 } });
	const started = Date.now();

	await assert.rejects(reviewStatus(root, { binary: cli.binary, timeoutMs: 200 }), /did not finish within 200 ms/);
	assert.ok(Date.now() - started < 4_000);
});

test("an invocation is split like a shell command line, not on spaces alone", () => {
	assert.deepEqual(splitInvocation(`gentle-ai review start --cwd "/work/my repo" --lineage=a`), [
		"gentle-ai",
		"review",
		"start",
		"--cwd",
		"/work/my repo",
		"--lineage=a",
	]);
	assert.deepEqual(splitInvocation(`gentle-ai review start --consent 'granted'`), [
		"gentle-ai",
		"review",
		"start",
		"--consent",
		"granted",
	]);
	assert.throws(() => splitInvocation(`gentle-ai review "unterminated`), /unterminated/);
});

test("the bridge answers a review status request with the panel's own shape", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review status": { fixture: "status-execute.json" } });
	const server = await startBridgeServer({ workspace: root, review: { binary: cli.binary } });
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	try {
		await new Promise((resolve) => ws.on("open", resolve));
		const answered = next(ws, (message) => message.kind === "review" && message.id === "review-1");
		ws.send(JSON.stringify({ kind: "review", id: "review-1", action: "status" }));

		const message = await answered;
		assert.equal(message.kind, "review");
		if (message.kind !== "review") return;
		assert.equal(message.action, "status");
		const data = message.data as ReviewStatusView;
		assert.equal(data.state, "ok");
		assert.equal(data.transition?.kind, "execute");
	} finally {
		ws.close();
		await server.close();
	}
});

test("the bridge answers a review request it cannot serve with a typed error", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review start": { fixture: "consent.json" } });
	const server = await startBridgeServer({ workspace: root, review: { binary: cli.binary } });
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	try {
		await new Promise((resolve) => ws.on("open", resolve));
		const answered = next(ws, (message) => message.kind === "error" && message.id === "review-2");
		ws.send(JSON.stringify({ kind: "review", id: "review-2", action: "start", tokens: [] }));

		const message = await answered;
		assert.equal(message.kind, "error");
		if (message.kind !== "error") return;
		assert.match(message.message, /needs the tokens/);
	} finally {
		ws.close();
		await server.close();
	}
});

test("assess can be pointed at a base commit, so committed work is assessable", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review assess": { fixture: "assess.json" } });
	await reviewAssess(root, { binary: cli.binary }, "HEAD~1");
	assert.deepEqual(cli.calls(), [["review", "assess", "--cwd", root, "--json", "--base-ref", "HEAD~1"]]);
});

test("a base ref that could be read as another flag is refused, not forwarded", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review assess": { fixture: "assess.json" } });
	for (const bad of ["--cwd", "-x", "HEAD --json", "", "HEAD\n~1"]) {
		await assert.rejects(() => reviewAssess(root, { binary: cli.binary }, bad), (error: Error) =>
			error.message.includes("base ref"),
		);
	}
	assert.deepEqual(cli.calls(), []);
});

test("assess relays the declaration's own tokens after the base ref", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review assess": { fixture: "assess.json" } });
	const declaration = [
		"--untracked-scope=select",
		`--expected-untracked-inventory=${UNTRACKED_INVENTORY}`,
		"--intended-untracked=docs/notes.md",
	];

	await reviewAssess(root, { binary: cli.binary }, "HEAD~1", declaration);

	assert.deepEqual(cli.calls(), [
		["review", "assess", "--cwd", root, "--json", "--base-ref", "HEAD~1", ...declaration],
	]);
});

test("an assess declaration that is not an untracked provider token is refused before the provider runs", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review assess": { fixture: "assess.json" } });
	const elsewhere = join(scratch(t), "elsewhere");
	const cases: readonly (readonly [readonly string[], RegExp])[] = [
		[["not-a-flag"], /is not a --flag/],
		[["--consent=granted"], /must not answer consent/],
		[[`--cwd=${elsewhere}`], /targets a different workspace/],
		[["--base-ref=main"], /not an untracked declaration/],
	];

	for (const [tokens, message] of cases) {
		await assert.rejects(() => reviewAssess(root, { binary: cli.binary }, undefined, tokens), message);
	}
	assert.deepEqual(cli.calls(), [], "the provider must not run for a refused declaration");
});

test("the bridge relays an assess declaration and a base ref from the wire to the provider", async (t) => {
	const root = repository(t);
	const cli = fakeCli(t, { "review assess": { fixture: "assess.json" } });
	const server = await startBridgeServer({ workspace: root, review: { binary: cli.binary } });
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.token}`);
	const declaration = [
		"--untracked-scope=select",
		`--expected-untracked-inventory=${UNTRACKED_INVENTORY}`,
		"--intended-untracked=docs/notes.md",
	];
	try {
		await new Promise((resolve) => ws.on("open", resolve));
		const answered = next(ws, (message) => message.kind === "review" && message.id === "review-assess");
		ws.send(
			JSON.stringify({ kind: "review", id: "review-assess", action: "assess", baseRef: "HEAD~1", untracked: declaration }),
		);

		const message = await answered;
		assert.equal(message.kind, "review");
		if (message.kind !== "review") return;
		assert.equal(message.action, "assess");
		assert.deepEqual(cli.calls(), [
			["review", "assess", "--cwd", root, "--json", "--base-ref", "HEAD~1", ...declaration],
		]);
	} finally {
		ws.close();
		await server.close();
	}
});
