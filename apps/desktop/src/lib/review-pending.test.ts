import assert from "node:assert/strict";
import test from "node:test";
import { COMMITTED_BASE_REF, isNothingPendingError } from "./review-pending.ts";

const PROVIDER =
	"review assess failed (exit 1): Error: the review assess candidate has no pending changes; already-committed work can be assessed by rerunning `gentle-ai review assess --base-ref <commit>` naming the base to compare against";

test("the provider's nothing-to-assess answer is recognised, not shown as the panel's own failure", () => {
	assert.equal(isNothingPendingError(PROVIDER), true);
	assert.equal(isNothingPendingError("the review assess candidate has no pending changes"), true);
	assert.equal(isNothingPendingError("COLLECT empty_candidate_base_ref_required"), true);
});

test("every other answer stays a failure", () => {
	assert.equal(isNothingPendingError("review status failed (exit 2): permission denied"), false);
	assert.equal(isNothingPendingError("the provider answered with text that is not JSON"), false);
	assert.equal(isNothingPendingError(""), false);
	assert.equal(isNothingPendingError("the candidate has pending changes"), false);
});

test("the base the panel offers is the commit the tree sits on", () => {
	assert.equal(COMMITTED_BASE_REF, "HEAD~1");
});
