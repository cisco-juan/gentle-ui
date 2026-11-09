import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewTransition } from "@gentle-shell/protocol";
import { describeReviewTransition, readReviewerAnswer, reviewerLens } from "./review-transition.ts";

/** A transition the provider actually answered with: `review status` … `next_transition`. */
function transition(overrides: Partial<ReviewTransition>): ReviewTransition {
	return { kind: "stop", reasonCode: "", execute: null, collect: [], ...overrides };
}

/** One collect slot; `captureOperation` is the provider's own verb, or empty when it named none. */
function slot(name: string, captureOperation: string) {
	return { name, schema: "", captureOperation, arguments: [], binding: [] };
}

test("a stop transition says the provider stops, with its own reason code", () => {
	const summary = describeReviewTransition(transition({ kind: "stop", reasonCode: "rdd_disabled" }));

	assert.equal(summary.kind, "stop");
	assert.equal(summary.reasonCode, "rdd_disabled");
	assert.equal(summary.summary, "The provider stops here: rdd_disabled.");
	assert.deepEqual(summary.verbs, []);
	assert.equal(summary.capturesRunnable, false);

	// A reason the provider did not state is not given one.
	const silent = describeReviewTransition(transition({ kind: "stop" }));
	assert.equal(silent.reasonCode, "");
	assert.equal(silent.summary, "The provider stops here, without a reason code.");
});

test("an execute transition names the provider's own operation", () => {
	const summary = describeReviewTransition(
		transition({
			kind: "execute",
			reasonCode: "fresh_target_ready",
			execute: { operation: "review.start", command: "gentle-ai review start --cwd=/work/repo", tokens: ["--cwd=/work/repo"], lineageId: null, targetIdentity: null },
		}),
	);

	assert.equal(summary.kind, "execute");
	assert.equal(summary.reasonCode, "fresh_target_ready");
	assert.equal(summary.summary, "The provider offers to run review.start.");
	assert.deepEqual(summary.verbs, []);

	const unnamed = describeReviewTransition(
		transition({ kind: "execute", execute: { operation: "", command: "", tokens: ["--target=sha256:abc"], lineageId: null, targetIdentity: null } }),
	);
	assert.equal(unnamed.summary, "The provider offers a step but named no operation.");
});

test("a collect transition names its slots and the exact provider capture verbs", () => {
	const summary = describeReviewTransition(
		transition({
			kind: "collect",
			reasonCode: "reviewer_results_required",
			collect: [slot("reviewer_result", "review.capture-result"), slot("intended_untracked_selection", "external.select_intended_untracked")],
		}),
	);

	assert.equal(summary.kind, "collect");
	assert.equal(summary.reasonCode, "reviewer_results_required");
	assert.equal(summary.summary, "The provider is waiting for reviewer_result, intended_untracked_selection.");
	// Verbatim: a rewritten verb would name a command the provider never offered.
	assert.deepEqual(summary.verbs, ["review.capture-result", "external.select_intended_untracked"]);
	// The reviewer step that would satisfy these does not exist in this panel.
	assert.equal(summary.capturesRunnable, false);
});

test("a collect transition with nothing usable names no slot and no verb", () => {
	const empty = describeReviewTransition(transition({ kind: "collect", reasonCode: "empty_candidate_base_ref_required" }));

	assert.equal(empty.kind, "collect");
	assert.equal(empty.summary, "The provider is waiting for a capture step it did not name.");
	assert.deepEqual(empty.verbs, []);

	const unnamed = describeReviewTransition(
		transition({ kind: "collect", reasonCode: "empty_candidate_base_ref_required", collect: [slot("base_ref", "")] }),
	);
	assert.equal(unnamed.summary, "The provider is waiting for base_ref.");
	assert.deepEqual(unnamed.verbs, []);
	assert.equal(unnamed.capturesRunnable, false);
});

test("an absent or malformed transition is reported as such, never invented", () => {
	const absent = describeReviewTransition(null);
	assert.equal(absent.kind, "absent");
	assert.equal(absent.summary, "The provider offered no next transition.");
	assert.equal(absent.reasonCode, "");
	assert.deepEqual(absent.verbs, []);

	const malformed = describeReviewTransition({ kind: "wander" } as unknown as ReviewTransition);
	assert.equal(malformed.kind, "absent");
	assert.equal(malformed.summary, "The provider's next transition is not one this panel can read.");
	assert.deepEqual(malformed.verbs, []);
});

test("a collect the panel already answers above is not described as a missing reviewer step", () => {
	const base = describeReviewTransition({
		kind: "collect",
		reasonCode: "empty_candidate_base_ref_required",
		execute: null,
		collect: [{ name: "base", captureOperation: "external.base_ref", schema: "", arguments: [], binding: {} }],
	} as never);
	assert.equal(base.satisfiedAbove, true);

	const selection = describeReviewTransition({
		kind: "collect",
		reasonCode: "intended_untracked_selection_required",
		execute: null,
		collect: [
			{
				name: "intended_untracked_selection",
				captureOperation: "external.select_intended_untracked",
				schema: "",
				arguments: [],
				binding: {},
			},
		],
	} as never);
	assert.equal(selection.satisfiedAbove, true);

	const reviewer = describeReviewTransition({
		kind: "collect",
		reasonCode: "reviewer_run_required",
		execute: null,
		collect: [{ name: "risk", captureOperation: "gentle-ai capture-result", schema: "", arguments: [], binding: {} }],
	} as never);
	assert.equal(reviewer.satisfiedAbove, false);
});

/**
 * The reviewer collect the provider recorded for `review status`, with its own five tokens.
 *
 * Copied field for field from `packages/bridge/test/fixtures/status-collect.json`, so the panel is
 * pinned against a transition the provider actually emitted rather than one invented here.
 */
function reviewerCollect(options: { readonly lensToken?: string | null; readonly name?: string } = {}): ReviewTransition {
	const lensToken = options.lensToken === undefined ? "--lens=review-reliability" : options.lensToken;
	const args = [
		{ name: "lineage", value: "review-b005087be055cc9b", token: "--lineage=review-b005087be055cc9b" },
		{ name: "expected-revision", value: "sha256:c7406e7d", token: "--expected-revision=sha256:c7406e7d" },
		{ name: "target", value: "sha256:0db81e73", token: "--target=sha256:0db81e73" },
		...(lensToken === null ? [] : [{ name: "lens", value: "review-reliability", token: lensToken }]),
		{ name: "order", value: "0", token: "--order=0" },
	];

	return transition({
		kind: "collect",
		reasonCode: "reviewer_results_required",
		collect: [
			{
				name: options.name ?? "reviewer_result",
				schema: "",
				captureOperation: "review.capture-result",
				arguments: args,
				binding: [
					{ name: "lens", value: "review-reliability", token: null },
					{ name: "selected_order", value: "0", token: null },
				],
			},
		],
	});
}

test("a reviewer collect is runnable by the panel, naming the lens from the provider's own token", () => {
	const lens = reviewerLens(reviewerCollect());

	assert.equal(lens?.lens, "review-reliability");
	// Exactly the provider's tokens, in its order: the panel adds none and rewrites none.
	assert.deepEqual(lens?.tokens, [
		"--lineage=review-b005087be055cc9b",
		"--expected-revision=sha256:c7406e7d",
		"--target=sha256:0db81e73",
		"--lens=review-reliability",
		"--order=0",
	]);
	// `--input` and `--preflight` are the bridge's own flags: it refuses a caller that sends one, so
	// the panel must never helpfully put one back.
	assert.deepEqual(
		lens?.tokens.filter((token) => token.startsWith("--input") || token.startsWith("--preflight")),
		[],
	);
});

test("a reviewer collect without a `--lens` token names the lens by its slot", () => {
	const lens = reviewerLens(reviewerCollect({ lensToken: null, name: "review-reliability" }));

	assert.equal(lens?.lens, "review-reliability");
	assert.deepEqual(lens?.tokens, [
		"--lineage=review-b005087be055cc9b",
		"--expected-revision=sha256:c7406e7d",
		"--target=sha256:0db81e73",
		"--order=0",
	]);
});

test("a collect the panel answers above, or one with no capture verb, is not a lens to run", () => {
	// The choices the panel already offers above the block belong to it, not to a reviewer.
	assert.equal(
		reviewerLens(transition({ kind: "collect", reasonCode: "empty_candidate_base_ref_required", collect: [slot("base", "external.base_ref")] })),
		null,
	);
	assert.equal(
		reviewerLens(
			transition({
				kind: "collect",
				reasonCode: "intended_untracked_selection_required",
				collect: [slot("intended_untracked_selection", "external.select_intended_untracked")],
			}),
		),
		null,
	);
	// A slot with no verb is a capture this panel cannot name, so it cannot run it either.
	assert.equal(reviewerLens(transition({ kind: "collect", reasonCode: "reviewer_results_required", collect: [slot("reviewer_result", "")] })), null);
	assert.equal(reviewerLens(transition({ kind: "stop", reasonCode: "rdd_disabled" })), null);
	assert.equal(
		reviewerLens(
			transition({
				kind: "execute",
				execute: { operation: "review.start", command: "gentle-ai review start", tokens: ["--cwd=/work/repo"], lineageId: null, targetIdentity: null },
			}),
		),
		null,
	);
	assert.equal(reviewerLens(null), null);
});

/** The reviewer result both bridge fixtures record: `subject_hash`, `inspection`, `findings`, `evidence`. */
const SUBMISSION = {
	subject_hash: `sha256:${"4".repeat(64)}`,
	inspection: { status: "completed", paths: ["src/App.tsx"] },
	findings: [],
	evidence: ["read src/App.tsx"],
};

test("an answer that is the submission's JSON is handed on as the object it parsed to", () => {
	const plain = readReviewerAnswer(JSON.stringify(SUBMISSION));
	assert.equal(plain.ok, true);
	assert.deepEqual(plain.ok ? plain.value : null, SUBMISSION);

	// A reviewer that explains itself and fences the answer is still answering the same thing.
	const fenced = readReviewerAnswer(`Here is the result.\n\n\`\`\`json\n${JSON.stringify(SUBMISSION, null, 2)}\n\`\`\`\n`);
	assert.deepEqual(fenced.ok ? fenced.value : null, SUBMISSION);
});

test("an answer that is not the submission's JSON is refused with a plain reason", () => {
	const prose = readReviewerAnswer("No findings worth capturing.");
	assert.equal(prose.ok, false);
	assert.match(prose.ok ? "" : prose.reason, /not JSON/);

	const empty = readReviewerAnswer("   \n");
	assert.equal(empty.ok, false);
	assert.match(empty.ok ? "" : empty.reason, /not JSON/);

	// JSON, but not the object the provider's submission is.
	const list = readReviewerAnswer("[1, 2, 3]");
	assert.equal(list.ok, false);
	assert.match(list.ok ? "" : list.reason, /object/);

	// The right object with fields missing: the reason names them, so the answer can be rerun.
	const missing = readReviewerAnswer(JSON.stringify({ subject_hash: "sha256:1", inspection: { status: "completed" } }));
	assert.equal(missing.ok, false);
	assert.match(missing.ok ? "" : missing.reason, /missing findings, evidence/);
});
