import type { ReviewTransition } from "@gentle-shell/protocol";

/**
 * What the panel can honestly say about the provider's next transition.
 *
 * `describeReviewTransition` is a description: it names the provider's own slots, verbs and reason
 * codes and invents none of them. Whether one of those collects can be run is a separate question,
 * answered by `reviewerLens()` from the same transition — the panel runs one lens, on the provider's
 * own tokens, and reads the reviewer's answer through `readReviewerAnswer()` before submitting it.
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
	/**
	 * Kept false for every transition. Whether the panel can actually run a collect is answered by
	 * `reviewerLens()`, which knows the provider's own tokens for one lens; this field never was that
	 * answer and is not one now.
	 */
	readonly capturesRunnable: false;
	/**
	 * True when the provider is waiting for a choice this panel already offers above the block — the base
	 * ref of a clean tree, or a declaration for untracked files — so the copy must not call it a reviewer
	 * step the panel lacks.
	 */
	readonly satisfiedAbove: boolean;
}

const ABSENT: ReviewTransitionSummary = {
	kind: "absent",
	reasonCode: "",
	summary: "The provider offered no next transition.",
	verbs: [],
	capturesRunnable: false,
	satisfiedAbove: false,
};

/** Provider operations this panel answers itself, above the transition block. */
const SATISFIED_ABOVE: ReadonlySet<string> = new Set([
	"external.select_intended_untracked",
	"external.base_ref",
	"external.empty_candidate_base_ref_required",
]);

/** The provider's own rendering of the lens it selected. */
const LENS_TOKEN = "--lens=";

/** One lens a collect transition asks for, ready to run: the lens it named and its own tokens. */
export interface ReviewerLens {
	/** The provider's `--lens=…` value, or its slot name when it rendered no such token; may be empty. */
	readonly lens: string;
	/** The provider's own tokens for this slot, in its order, relayed untouched. */
	readonly tokens: readonly string[];
}

/**
 * The fields the provider's reviewer submission carries.
 *
 * Both recorded reviewer results in this repository — the wire test's and the bridge's unit test's —
 * are exactly these four, so a reviewer answer missing one is not the JSON `capture-result` reads.
 */
export const REVIEWER_SUBMISSION_FIELDS = ["subject_hash", "inspection", "findings", "evidence"] as const;

/** Whether a reviewer's answer is the JSON the provider's submission needs, or why it is not. */
export type ReviewerAnswer =
	| { readonly ok: true; readonly value: Record<string, unknown> }
	| { readonly ok: false; readonly reason: string };

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
			satisfiedAbove: verbs.some((verb) => SATISFIED_ABOVE.has(verb)) || reasonCode.includes("base_ref"),
		};
	}

	return { ...ABSENT, summary: "The provider's next transition is not one this panel can read." };
}

/**
 * The one lens a collect transition asks the panel to run, with the provider's own tokens for it.
 *
 * `null` means there is nothing here the panel runs: the transition is not a collect, it asks for a
 * choice the panel already offers above the block, or it named no capture verb at all. The lens is
 * the provider's own `--lens=…` rendering when it emitted one and the slot's name when it did not —
 * never a name this module invented. The tokens are relayed untouched: `--input` and `--preflight`
 * belong to the bridge, which refuses a caller that sends one, so nothing here adds or rewrites a
 * token.
 */
export function reviewerLens(transition: ReviewTransition | null | undefined): ReviewerLens | null {
	if (transition === null || transition === undefined || typeof transition !== "object") return null;
	if ((transition as { readonly kind?: unknown }).kind !== "collect") return null;

	const inputs = Array.isArray(transition.collect) ? transition.collect : [];
	const slot = inputs.find((input) => {
		const verb = text(input?.captureOperation);
		return verb.length > 0 && !SATISFIED_ABOVE.has(verb);
	});
	if (slot === undefined) return null;

	const tokens = [...tokenList(slot.arguments), ...tokenList(slot.binding)];
	const lensToken = tokens.find((token) => token.startsWith(LENS_TOKEN));
	return { lens: lensToken === undefined ? text(slot.name) : lensToken.slice(LENS_TOKEN.length).trim(), tokens };
}

function summary(kind: "stop" | "execute", reasonCode: string, line: string): ReviewTransitionSummary {
	return { kind, reasonCode, summary: line, verbs: [], capturesRunnable: false, satisfiedAbove: false };
}

/** A trimmed, non-empty string, or the empty string: the provider's emptiness is not a value. */
function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** The provider's own flag renderings of one argument list, blanks dropped and nothing rewritten. */
function tokenList(entries: unknown): readonly string[] {
	if (!Array.isArray(entries)) return [];
	return entries.map((entry) => text((entry as { readonly token?: unknown } | null)?.token)).filter((token) => token.length > 0);
}

/**
 * Read the reviewer's answer as the JSON the provider's submission takes.
 *
 * A reviewer explains itself, so the answer may be prose with the object fenced or bare; the object is
 * what the submission carries. Anything else is refused here, before it can reach `capture-result`, and
 * the reason says which of the three ways it failed: not JSON at all, JSON that is not an object, or an
 * object missing a field the submission needs.
 */
export function readReviewerAnswer(answer: string): ReviewerAnswer {
	const found = jsonValue(typeof answer === "string" ? answer : "");
	if (!found.ok) {
		return { ok: false, reason: "the reviewer's answer is not JSON, so there is nothing the provider's submission could carry." };
	}

	const value = found.value;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, reason: "the reviewer's answer is JSON but not an object, and the provider's submission is a JSON object." };
	}

	const record = value as Record<string, unknown>;
	const missing = REVIEWER_SUBMISSION_FIELDS.filter((field) => !(field in record));
	if (missing.length > 0) {
		return {
			ok: false,
			reason: `the reviewer's answer is missing ${missing.join(", ")}, which the provider's submission needs.`,
		};
	}

	return { ok: true, value: record };
}

/** The first JSON value in an answer: the whole text, a fenced block, or the braces inside it. */
function jsonValue(answer: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
	const candidates: string[] = [];
	const trimmed = answer.trim();
	if (trimmed.length === 0) return { ok: false };
	candidates.push(trimmed);

	const fenced = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(answer);
	if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());

	const first = trimmed.indexOf("{");
	const last = trimmed.lastIndexOf("}");
	if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

	for (const candidate of candidates) {
		try {
			return { ok: true, value: JSON.parse(candidate) };
		} catch {
			// Not this one; the next candidate is the reviewer's answer in another shape.
		}
	}

	return { ok: false };
}

/** Drop the blanks and the repeats, keeping the provider's own order. */
function unique(values: readonly string[]): readonly string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}
