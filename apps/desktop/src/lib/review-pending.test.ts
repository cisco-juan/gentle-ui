import assert from "node:assert/strict";
import test from "node:test";
import { COMMITTED_BASE_REF, isNothingPendingError, isUntrackedDeclarationError } from "./review-pending.ts";

const PROVIDER =
	"review assess failed (exit 1): Error: the review assess candidate has no pending changes; already-committed work can be assessed by rerunning `gentle-ai review assess --base-ref <commit>` naming the base to compare against";

const UNTRACKED =
	"review assess failed (exit 1): Error: untracked files require an explicit declaration; run `gentle-ai review status --cwd <repo> --contract gentle-ai.review-integration/v2 --agent <runtime> --next-transition` to obtain the canonical inventory, then rerun `gentle-ai review assess` with --untracked-scope=exclude --expected-untracked-inventory=sha256:cc090fa97db9cb7239a0572b1c12c94ecb94fe5417ee421e78337b49f8484926 or --untracked-scope=select --intended-untracked=<repo-relative-path> --expected-untracked-inventory=sha256:cc090fa97db9cb7239a0572b1c12c94ecb94fe5417ee421e78337b49f8484926";

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

test("the provider's untracked-declaration answer is recognised, not shown as the panel's own failure", () => {
	assert.equal(isUntrackedDeclarationError(UNTRACKED), true);
	assert.equal(isUntrackedDeclarationError("Error: untracked files require an explicit declaration"), true);
});

test("the untracked answer is not the nothing-pending answer, and neither is the other", () => {
	assert.equal(isUntrackedDeclarationError(PROVIDER), false);
	assert.equal(isNothingPendingError(UNTRACKED), false);
	assert.equal(isUntrackedDeclarationError("review status failed (exit 2): permission denied"), false);
	assert.equal(isUntrackedDeclarationError(""), false);
});

test("the base the panel offers is the commit the tree sits on", () => {
	assert.equal(COMMITTED_BASE_REF, "HEAD~1");
});
