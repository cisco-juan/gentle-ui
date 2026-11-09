import { isNothingPendingError, isUntrackedDeclarationError } from "../lib/review-pending";
import { createSignal, untrack, type Accessor } from "solid-js";
import type {
	ReviewAssessment,
	ReviewConsent,
	ReviewConsentChoice,
	ReviewMode,
	ReviewStartView,
	ReviewStatusView,
} from "@gentle-shell/protocol";
import type { BridgeClient } from "../lib/bridge";

/**
 * Native review panel state.
 *
 * The provider's authority is not mirrored here: this module asks the bridge and renders the answer it
 * gets. Three rules follow from that.
 * - Nothing is invented. A failure, an unreadable answer, or a workspace that is not a repository is
 *   held as text and shown as such, never as a plausible review state.
 * - A start carries the tokens the status offered. The panel reads them from the status it is showing,
 *   so it cannot start a target the provider did not just describe.
 * - The consent card is the provider's envelope, verbatim. Both choices come from it, and answering one
 *   replays its own invocation through the bridge; the panel never composes a command line.
 */

/** The inspector's fifth tab; the inspector imports this entry instead of a bare string. */
export const REVIEW_TAB = { id: "review", label: "Review" } as const;

export interface ReviewView {
	/** The provider's answer, or null before the first one arrives. */
	readonly status: ReviewStatusView | null;
	readonly mode: ReviewMode | null;
	/** The read-only risk a start would freeze; extra context, so its failure does not blank the panel. */
	readonly assessment: ReviewAssessment | null;
	readonly loading: boolean;
	readonly error: string | null;
	readonly assessmentError: string | null;
	/** True when the provider's answer was "nothing uncommitted to assess", which is a state, not a failure. */
	readonly assessmentPending: boolean;
	/** True when untracked files refused the assessment; the declaration to offer rides on the status. */
	readonly assessmentUntracked: boolean;
	/** What just happened: a started review, a skipped change, a consent question waiting. */
	readonly notice: string | null;
}

export interface ReviewPanel {
	readonly view: Accessor<ReviewView>;
	/** The blocking question the provider asked, if any. */
	readonly consent: Accessor<ReviewConsent | null>;
	readonly busy: Accessor<boolean>;
	readonly assessmentPending: Accessor<boolean>;
	refresh(): Promise<void>;
	/** Assess pending changes, or committed work against `baseRef` when the tree is clean. */
	assess(baseRef?: string): Promise<void>;
	/** Assess with the untracked declaration the status on screen offered, when there is one. */
	assessUntracked(): Promise<void>;
	/** Start with the tokens the status on screen carries. */
	start(): Promise<void>;
	/** Answer the consent card by replaying the chosen invocation. */
	answer(choice: ReviewConsentChoice): Promise<void>;
	stop(): void;
}

const EMPTY_VIEW: ReviewView = {
	status: null,
	mode: null,
	assessment: null,
	loading: false,
	error: null,
	assessmentError: null,
	assessmentPending: false,
	assessmentUntracked: false,
	notice: null,
};

/** Create the panel. Call it from a component so any future effect has an owner. */
export function createReviewPanel(options: { readonly connect: () => BridgeClient | null }): ReviewPanel {
	const [view, setView] = createSignal<ReviewView>(EMPTY_VIEW);
	const [consent, setConsent] = createSignal<ReviewConsent | null>(null);
	const [busy, setBusy] = createSignal(false);

	// Every load carries a generation so a slow answer cannot overwrite a newer one.
	let run = 0;
	let stopped = false;

	async function refresh(): Promise<void> {
		const client = options.connect();
		const current = ++run;
		if (client === null) {
			setView((value) => ({ ...value, loading: false, error: "the bridge is not connected" }));
			return;
		}

		setView((value) => ({ ...value, loading: true, error: null }));
		let status: ReviewStatusView;
		let mode: ReviewMode;
		try {
			[status, mode] = await Promise.all([client.review({ action: "status" }), client.review({ action: "mode" })]);
		} catch (error) {
			if (current !== run || stopped) return;
			setView((value) => ({
				...value,
				status: null,
				mode: null,
				assessment: null,
				loading: false,
				error: messageOf(error),
				assessmentPending: false,
				assessmentUntracked: false,
			}));
			return;
		}
		if (current !== run || stopped) return;
		setView((value) => ({ ...value, status, mode, loading: false, error: null }));

		// The assessment is context for the consent the user is about to give, so its own failure is
		// reported beside that block instead of replacing a status the provider did answer.
		await assess();
	}

	/**
	 * The risk a start would freeze, of pending changes or of committed work against a base.
	 *
	 * A clean tree makes the provider answer "no pending changes", and untracked files make it refuse
	 * until it receives an explicit declaration; both are states the panel offers an action for, not
	 * failures it colours red. The declaration tokens are the provider's own, relayed untouched.
	 */
	async function assess(baseRef?: string, untracked?: readonly string[]): Promise<void> {
		const client = options.connect();
		if (client === null) return;
		const current = run;
		try {
			const assessment = await client.review({
				action: "assess",
				...(baseRef === undefined ? {} : { baseRef }),
				...(untracked === undefined ? {} : { untracked }),
			});
			if (current !== run || stopped) return;
			setView((value) => ({
				...value,
				assessment,
				assessmentError: null,
				assessmentPending: false,
				assessmentUntracked: false,
			}));
		} catch (error) {
			if (current !== run || stopped) return;
			const message = messageOf(error);
			const pending = isNothingPendingError(message);
			// Only the refusal to start is an offer. A declaration the user already sent that fails
			// again is a plain failure, so the same action is not re-offered in a loop.
			const untrackedOffer = untracked === undefined && isUntrackedDeclarationError(message);
			setView((value) => ({
				...value,
				assessment: null,
				assessmentError: pending || untrackedOffer ? null : message,
				assessmentPending: pending,
				assessmentUntracked: untrackedOffer,
			}));
		}
	}

	/**
	 * Assess with the declaration the provider's own status offered.
	 *
	 * The tokens are read from the status on screen, never rebuilt here. A status without a usable
	 * selection has nothing this panel can run, and it says that instead of sending a guess.
	 */
	async function assessUntracked(): Promise<void> {
		const tokens = untrack(() => view().status?.untracked?.tokens ?? []);
		if (tokens.length === 0) {
			setView((value) => ({
				...value,
				assessmentError:
					"the provider did not offer an untracked-file declaration in this status; refresh before assessing",
			}));
			return;
		}
		await assess(undefined, tokens);
	}

	async function start(): Promise<void> {
		const client = options.connect();
		if (client === null) {
			setView((value) => ({ ...value, error: "the bridge is not connected" }));
			return;
		}

		const tokens = untrack(() => view().status?.transition?.execute?.tokens ?? []);
		if (tokens.length === 0) {
			setView((value) => ({ ...value, error: "this status carries no start tokens; refresh before starting" }));
			return;
		}

		setBusy(true);
		try {
			applyAnswer(await client.review({ action: "start", tokens }));
		} catch (error) {
			setView((value) => ({ ...value, error: messageOf(error) }));
		} finally {
			setBusy(false);
		}
	}

	async function answer(choice: ReviewConsentChoice): Promise<void> {
		const client = options.connect();
		if (client === null) {
			setView((value) => ({ ...value, error: "the bridge is not connected" }));
			return;
		}

		setBusy(true);
		try {
			applyAnswer(await client.review({ action: "consent", invocation: choice.invocation }));
		} catch (error) {
			// The card stays on screen with the error beside it, so the answer can be retried.
			setView((value) => ({ ...value, error: messageOf(error) }));
		} finally {
			setBusy(false);
		}
	}

	/** One start or consent answer: a question to answer, a lineage to show, or a skipped change. */
	function applyAnswer(answer: ReviewStartView): void {
		if (answer.outcome === "consent") {
			setConsent(answer.consent);
			setView((value) => ({ ...value, notice: answer.message, error: null }));
			return;
		}

		setConsent(null);
		setView((value) => ({ ...value, notice: answer.message, error: null }));
		void refresh();
	}

	function stop(): void {
		stopped = true;
		run += 1;
	}

	return { view, consent, busy, assessmentPending: () => view().assessmentPending, refresh, assess, assessUntracked, start, answer, stop };
}

/**
 * The mode line, in the panel's words.
 *
 * `effective` is what decides whether a review happens at all, and `source` says who decided: a clone
 * can turn reviews off for itself, and no other clone inherits that.
 */
export function modeLabel(mode: ReviewMode | null): string {
	if (mode === null) return "review mode unknown";
	const state = mode.effective.length === 0 ? "review ?" : `review ${mode.effective}`;
	const source = mode.source.length === 0 ? "source unknown" : mode.source;
	return `${state} · ${source}`;
}

/** Which tone the mode chip uses: reviews on is good news, off is not a failure. */
export function modeTone(mode: ReviewMode | null): "on" | "off" | "unknown" {
	if (mode === null || mode.effective.length === 0) return "unknown";
	return mode.effective === "on" ? "on" : "off";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
