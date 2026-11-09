import type { ReviewTransition } from "@gentle-shell/protocol";

/**
 * What the panel can honestly say about the provider's next transition.
 *
 * This is a description, not an offer: the reviewer step that would satisfy a `collect` does not
 * exist in this panel, so its verbs are named and marked un-runnable instead of being turned into a
 * button. Nothing here invents a slot, a verb or a reason the provider did not state.
 */
export type ReviewTransitionView = "stop" | "execute" | "collect" | "absent";

export interface ReviewTransitionSummary {
	readonly kind: ReviewTransitionView;
	/** The provider's reason code, verbatim; empty when it named none. */
	readonly reasonCode: string;
	/** One line for the NEXT TRANSITION block. */
	readonly summary: string;
	/** The provider's own capture verbs this transition implies, in the order it listed them. */
	readonly verbs: readonly string[];
	/** False because capturing a result needs a reviewer step this panel does not implement yet. */
	readonly capturesRunnable: false;
}

const ABSENT: ReviewTransitionSummary = {
	kind: "absent",
	reasonCode: "",
	summary: "The provider offered no next transition.",
	verbs: [],
	capturesRunnable: false,
};

/** Turn the provider's transition into the panel's sentence, or say plainly that there is none. */
export function describeReviewTransition(
	transition: ReviewTransition | null | undefined,
): ReviewTransitionSummary {
	if (transition === null || transition === undefined || typeof transition !== "object") return ABSENT;

	const reasonCode = text(transition.reasonCode);
	const kind = (transition as { readonly kind?: unknown }).kind;

	if (kind === "stop") {
		return summary("stop", reasonCode, reasonCode.length === 0 ? "The provider stops here, without a reason code." : `The provider stops here: ${reasonCode}.`);
	}

	if (kind === "execute") {
		const operation = text(transition.execute?.operation);
		return summary(
			"execute",
			reasonCode,
			operation.length === 0 ? "The provider offers a step but named no operation." : `The provider offers to run ${operation}.`,
		);
	}

	if (kind === "collect") {
		const inputs = Array.isArray(transition.collect) ? transition.collect : [];
		const slots = unique(inputs.map((input) => text(input?.name)));
		const verbs = unique(inputs.map((input) => text(input?.captureOperation)));
		return {
			kind: "collect",
			reasonCode,
			summary:
				slots.length === 0
					? "The provider is waiting for a capture step it did not name."
					: `The provider is waiting for ${slots.join(", ")}.`,
			verbs,
			capturesRunnable: false,
		};
	}

	return { ...ABSENT, summary: "The provider's next transition is not one this panel can read." };
}

function summary(kind: "stop" | "execute", reasonCode: string, line: string): ReviewTransitionSummary {
	return { kind, reasonCode, summary: line, verbs: [], capturesRunnable: false };
}

/** A trimmed, non-empty string, or the empty string: the provider's emptiness is not a value. */
function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** Drop the blanks and the repeats, keeping the provider's own order. */
function unique(values: readonly string[]): readonly string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}
