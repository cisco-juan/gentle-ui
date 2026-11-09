/**
 * The provider's answer when there is nothing uncommitted to assess.
 *
 * `review assess` compares pending changes by default. On a clean tree it says so and names
 * `--base-ref` as the way to assess committed work; treating that as a panel failure painted the tab
 * red after every commit, which is what the user reported. The message is matched here, in one place,
 * so the panel can answer it with an action instead of an error.
 */
export function isNothingPendingError(message: string): boolean {
	const text = message.toLowerCase();
	return text.includes("no pending changes") || text.includes("empty_candidate_base_ref_required");
}

/** The base the panel offers when the tree is clean: the commit the working tree sits on. */
export const COMMITTED_BASE_REF = "HEAD~1";
