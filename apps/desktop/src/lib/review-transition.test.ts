import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewTransition } from "@gentle-shell/protocol";
import { describeReviewTransition } from "./review-transition.ts";

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
