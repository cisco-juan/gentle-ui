import { For, Show, createSignal, type Accessor, type JSX } from "solid-js";
import type { ReviewConsent, ReviewStatusView } from "@gentle-shell/protocol";
import "../review.css";
import { describeReviewTransition, reviewerLens } from "../lib/review-transition";
import { COMMITTED_BASE_REF } from "../lib/review-pending";
import { modeLabel, modeTone, type LensRunView, type ReviewPanel } from "../state/review";
import { SkeletonLines } from "./Skeleton";

/**
 * Native review (receipt-driven development), panel half of phase two.
 *
 * The tab observes what the provider says, starts a review with the tokens the provider itself
 * offered, and runs one reviewer lens: the provider's own context for that lens, one sessionless
 * reviewer on the thread's current model, then the provider's own dry run of the answer. A dry run
 * admits nothing, so the panel says so plainly and never reports it as an approved review. Every
 * block below is rendered from the bridge's typed answer, so a missing binary, a CLI error, or an
 * unreadable answer appears as exactly that with a refresh beside it — never as a plausible state.
 */
export function ReviewTab(props: { review: ReviewPanel; model: Accessor<string> }): JSX.Element {
	const view = () => props.review.view();
	const status = () => view().status;

	return (
		<div class="review">
			<div class="review-head">
				<span class={`review-mode ${modeTone(view().mode)}`}>{modeLabel(view().mode)}</span>
				<button
					type="button"
					class="inspector-action"
					disabled={view().loading}
					onClick={() => void props.review.refresh()}
				>
					{view().loading ? "reading…" : "refresh"}
				</button>
			</div>

			<div class="review-scroll">
				<Show when={view().notice}>{(notice) => <p class="review-notice">{notice()}</p>}</Show>
				<Show when={view().error}>{(error) => <p class="inspector-error">{error()}</p>}</Show>

				{/* A blocking question comes first: it is the only thing standing between the user and a start. */}
				<Show when={props.review.consent()}>
					{(consent) => <ConsentCard panel={props.review} consent={consent()} />}
				</Show>

				{/* Nothing has been asked yet and nothing failed: say so instead of showing an empty shell. */}
				<Show when={view().loading && status() === null}>
					<SkeletonLines count={5} label="Reading the review state" />
				</Show>

				<Show when={status() === null && view().error === null && !view().loading}>
					<p class="inspector-empty">No review state yet. Refresh to ask the provider.</p>
				</Show>

				<Show when={status()?.state === "empty"}>
					<p class="inspector-empty">{status()?.message}</p>
				</Show>

				<Show when={status()?.state === "unreadable"}>
					<section class="review-block">
						<h3 class="review-title">unreadable answer</h3>
						<p class="inspector-error">{status()?.message}</p>
						<pre class="review-raw">{status()?.raw ?? ""}</pre>
					</section>
				</Show>

				<Show when={status()?.state === "ok" && status()}>
					{(answered) => (
						<>
							<AuthorityBlock status={answered()} />
							<AssessmentBlock panel={props.review} />
							<TargetBlock status={answered()} />
							<TransitionBlock panel={props.review} model={props.model} status={answered()} />
							<p class="review-note">
								Abandon, recover, reclaim, quarantine, reconcile and repair need a maintainer's authorized command. This
								panel does not run them.
							</p>
						</>
					)}
				</Show>
			</div>
		</div>
	);
}

/** The authority on record, with the budget it froze; an honest empty state when there is none. */
function AuthorityBlock(props: { status: ReviewStatusView }): JSX.Element {
	return (
		<section class="review-block">
			<h3 class="review-title">authority</h3>
			<Show
				when={props.status.authority}
				fallback={<p class="inspector-empty">{props.status.message || "No review authority for this workspace yet."}</p>}
			>
				{(authority) => (
					<dl class="review-rows">
						<Row label="state" value={authority().state} />
						<Row label="lineage" value={authority().lineageId} mono />
						<Row label="revision" value={authority().revision} mono />
						<Row label="generation" value={String(authority().generation)} mono />
					</dl>
				)}
			</Show>
			<Show when={props.status.authorityStale}>
				<p class="review-warning">
					This authority is for an earlier target, so the changes here have not been reviewed.
				</p>
			</Show>
			<Show when={props.status.frozen}>
				{(frozen) => (
					<dl class="review-rows">
						<Row label="frozen tier" value={frozen().tier} />
						<Row label="correction budget" value={String(frozen().correctionBudget)} mono />
						<Row label="changed lines" value={String(frozen().changedLines)} mono />
						<Row label="manifest" value={frozen().changedPathManifestDigest} mono />
					</dl>
				)}
			</Show>
		</section>
	);
}

/** What a start would freeze right now, read-only. Its failure is its own line, not the panel's. */
function AssessmentBlock(props: { panel: ReviewPanel }): JSX.Element {
	const view = () => props.panel.view();
	const assessment = () => view().assessment;

	return (
		<section class="review-block">
			<h3 class="review-title">risk</h3>
			{/* A clean tree is not a failure: the provider names the base it can assess instead, and so do we. */}
			<Show when={props.panel.assessmentPending()}>
				<p class="review-notice">
					Nothing is uncommitted, so there are no pending changes to assess. The last commit can be assessed against its
					parent.
				</p>
				<button
					type="button"
					class="inspector-action"
					disabled={view().loading}
					onClick={() => void props.panel.assess(COMMITTED_BASE_REF)}
				>
					assess the last commit
				</button>
			</Show>
			{/* Untracked files are a declaration, not a failure: offer the provider's own selection. */}
			<Show when={view().assessmentUntracked}>
				<Show
					when={view().status?.untracked}
					fallback={
						<p class="review-notice">
							The provider refuses to assess while untracked files exist, but its status offered no declaration this
							panel can relay. Refresh to ask it again.
						</p>
					}
				>
					{(untracked) => (
						<>
							<p class="review-notice">
								The provider refuses to assess while untracked files exist. It offered a declaration that includes{" "}
								{untracked().paths.length === 1 ? "one untracked file" : `${untracked().paths.length} untracked files`}.
							</p>
							<ul class="review-paths">
								<For each={untracked().paths}>{(path) => <li class="mono">{path}</li>}</For>
							</ul>
							<button
								type="button"
								class="inspector-action"
								disabled={view().loading}
								onClick={() => void props.panel.assessUntracked()}
							>
								assess including the untracked files
							</button>
						</>
					)}
				</Show>
			</Show>
			<Show when={!props.panel.assessmentPending() && !view().assessmentUntracked && view().assessmentError}>
				{(error) => <Clamped text={error()} />}
			</Show>
			<Show when={assessment()}>
				{(answer) => (
					<>
						<dl class="review-rows">
							<Row label="tier" value={answer().risk} />
							<Row label="changed" value={`${answer().changedPaths} paths · ${answer().changedLines} lines`} mono />
							<Row label="review due" value={answer().reviewDue ? "yes" : "no"} />
							<Show when={answer().reviewDueReason.length > 0}>
								<Row label="why" value={answer().reviewDueReason} mono />
							</Show>
						</dl>
						<Show when={answer().reasons.length > 0}>
							<ul class="review-evidence">
								<For each={answer().reasons}>
									{(reason) => (
										<li>
											<span class="mono">{reason.code}</span>
											<Show when={reason.path}>{(path) => <span class="review-path"> {path()}</span>}</Show>
										</li>
									)}
								</For>
							</ul>
						</Show>
					</>
				)}
			</Show>
		</section>
	);
}

/**
 * A provider message, clamped.
 *
 * The provider explains itself at length, with digests and inventory hashes. Three lines are enough to
 * act on; the rest is one click away instead of pushing the rest of the panel off screen.
 */
function Clamped(props: { text: string; lines?: number }): JSX.Element {
	const [open, setOpen] = createSignal(false);
	const limit = () => props.lines ?? 3;
	const lineCount = () => props.text.split("\n").length;
	const hidden = () => !open() && lineCount() > limit();

	return (
		<div class="review-clamped">
			<p
				class="inspector-error"
				classList={{ clamped: hidden() }}
				style={hidden() ? { "-webkit-line-clamp": String(limit()) } : undefined}
			>
				{props.text}
			</p>
			<Show when={lineCount() > limit()}>
				<button type="button" class="review-more" onClick={() => setOpen((current) => !current)}>
					{open() ? "less" : "details"}
				</button>
			</Show>
		</div>
	);
}

/** What the review would be about: the target identity and the projection it was frozen from. */
function TargetBlock(props: { status: ReviewStatusView }): JSX.Element {
	return (
		<section class="review-block">
			<h3 class="review-title">target</h3>
			<dl class="review-rows">
				<Row label="identity" value={props.status.targetIdentity} mono />
				<Row label="projection" value={props.status.projection} mono />
				<Row label="applicability" value={props.status.applicability} mono />
			</dl>
			<Show when={props.status.changedPaths.length > 0}>
				<ul class="review-paths">
					<For each={props.status.changedPaths}>{(path) => <li class="mono">{path}</li>}</For>
				</ul>
			</Show>
		</section>
	);
}

/** The provider's next transition, described by the pure module and never invented here. */
function TransitionBlock(props: { panel: ReviewPanel; model: Accessor<string>; status: ReviewStatusView }): JSX.Element {
	const step = () => describeReviewTransition(props.status.transition);
	// The one lens this transition asks the panel to run, or nothing the panel can run.
	const runnable = () => {
		const lens = reviewerLens(props.status.transition);
		return lens === null || lens.lens.length === 0 ? null : lens;
	};
	const run = () => props.panel.lensRun();
	const running = () => run().step === "context" || run().step === "reviewer" || run().step === "capture";

	return (
		<section class="review-block">
			<h3 class="review-title">next transition</h3>
			<Show when={step().kind !== "absent"}>
				<div class="review-transition">
					<span class={`review-kind ${step().kind}`}>{step().kind}</span>
					<Show when={step().reasonCode}>{(reason) => <span class="review-reason mono">{reason()}</span>}</Show>
				</div>
			</Show>
			<p classList={{ "review-warning": step().kind === "stop", "review-note": step().kind !== "stop" }}>
				{step().summary}
			</p>

			<Show when={step().kind === "execute"}>
				<button
					type="button"
					class="review-primary"
					disabled={props.panel.busy()}
					onClick={() => void props.panel.start()}
				>
					{props.panel.busy() ? "starting…" : "Start review"}
				</button>
				<p class="review-note">
					Starts with this transition's own tokens and relays consent, so the provider always asks before it
					reviews.
				</p>
			</Show>

			{/* A collect the panel answers above is that choice, and nothing else is needed here. */}
			<Show when={step().kind === "collect" && step().satisfiedAbove}>
				<p class="inspector-empty">This step is the choice offered above; nothing else is needed here.</p>
			</Show>

			{/* A reviewer collect is runnable now: one lens, its context, one reviewer, the provider's dry run. */}
			<Show when={step().kind === "collect" && !step().satisfiedAbove}>
				<Show
					when={runnable()}
					fallback={
						<Show
							when={step().verbs.length > 0}
							fallback={
								<p class="inspector-empty">
									The provider named no capture verb for this step, so this panel has nothing to run.
								</p>
							}
						>
							<p class="review-warning">
								The provider named <span class="mono">{step().verbs.join(", ")}</span> for this step, but not the
								lens it belongs to, so there is nothing this panel can run. Refresh to ask it again.
							</p>
						</Show>
					}
				>
					{(lens) => (
						<>
							<dl class="review-rows">
								<Row label="lens" value={lens().lens} mono />
							</dl>
							<button
								type="button"
								class="review-primary"
								disabled={running() || props.panel.busy()}
								onClick={() => void props.panel.runLens(props.model())}
							>
								{running() ? "running…" : "run this lens"}
							</button>
							<p class="review-note">
								Runs the provider's own context for this lens, then one sessionless reviewer on{" "}
								<span class="mono">{props.model() || "the selected model"}</span>, then the provider's dry run of
								the answer. The dry run admits nothing: no review is captured or approved by this action.
							</p>
							<LensRunReport run={run()} />
						</>
					)}
				</Show>
			</Show>
		</section>
	);
}

/** The step a run is on, in the provider's own words, so no progress is implied that did not happen. */
function stepLabel(run: LensRunView): string {
	switch (run.step) {
		case "context":
			return "running the provider's lens context…";
		case "reviewer":
			return "running one sessionless reviewer…";
		case "capture":
			return "submitting to the provider's dry run…";
		case "done":
			return "dry run answered";
		case "failed":
			return run.failedStep === null ? "stopped before the first step" : `stopped at ${run.failedStep}`;
		default:
			return "";
	}
}

/**
 * What one lens run has actually produced: its step, the reviewer's text, and the provider's dry run.
 *
 * The dry-run answer is relayed verbatim and labelled as a dry run wherever it appears: it is the
 * provider proving a submission, not the provider admitting one.
 */
function LensRunReport(props: { run: LensRunView }): JSX.Element {
	return (
		<Show when={props.run.step !== "idle"}>
			<div class="review-run">
				<p classList={{ "review-step": true, failed: props.run.step === "failed" }}>{stepLabel(props.run)}</p>
				<Show when={props.run.error}>{(error) => <Clamped text={error()} />}</Show>

				<Show when={props.run.reviewer}>
					{(reviewer) => (
						<>
							<div class="review-run-head">
								<span class="review-title">reviewer</span>
								<Show when={reviewer().truncated}>
									<span class="tag-stage" title="The bridge capped this run's text, so this is not the whole answer.">
										truncated
									</span>
								</Show>
								<Show when={reviewer().exitCode !== 0}>
									<span class="tag-stage">exit {reviewer().exitCode}</span>
								</Show>
							</div>
							<pre class="review-raw reviewer">{reviewer().text}</pre>
						</>
					)}
				</Show>

				<Show when={props.run.capture}>
					{(capture) => (
						<div class="review-dryrun">
							<div class="review-run-head">
								<span class="review-title">dry run</span>
								<span class="tag-stage">nothing captured, nothing approved</span>
							</div>
							<p class="review-note">The provider's own answer to the dry run, exactly as it wrote it:</p>
							<pre class="review-raw">{capture().output}</pre>
						</div>
					)}
				</Show>
			</div>
		</Show>
	);
}

/** The blocking consent question, as a native card: both answers, their effects, and no bare token. */
function ConsentCard(props: { panel: ReviewPanel; consent: ReviewConsent }): JSX.Element {
	return (
		<section class="review-consent" aria-label="Review consent">
			<h3 class="review-headline">{props.consent.headline}</h3>
			<p class="review-reason">{props.consent.reason}</p>
			<p class="review-value">{props.consent.value}</p>

			<Show when={props.consent.riskEvidence.length > 0}>
				<ul class="review-evidence">
					<For each={props.consent.riskEvidence}>{(line) => <li>{line}</li>}</For>
				</ul>
			</Show>

			<dl class="review-rows">
				<Row label="tier" value={props.consent.riskLevel} />
				<Row label="changed" value={`${props.consent.changedFiles} files · ${props.consent.changedLines} lines`} mono />
			</dl>

			<div class="review-choices">
				<For each={props.consent.choices}>
					{(choice) => (
						<button
							type="button"
							classList={{ "review-choice": true, primary: choice.answer === "granted" }}
							disabled={props.panel.busy()}
							onClick={() => void props.panel.answer(choice)}
						>
							<span class="review-choice-label">{choice.label}</span>
							<span class="review-choice-effect">{choice.effect}</span>
						</button>
					)}
				</For>
			</div>

			<Show when={props.consent.offPath}>
				{(offPath) => (
					<p class="review-note">
						{offPath().note} <span class="mono">{offPath().command}</span>
					</p>
				)}
			</Show>
		</section>
	);
}

/** One labelled row of a definition list; `mono` marks ids, codes and digests. */
function Row(props: { label: string; value: string; mono?: boolean }): JSX.Element {
	return (
		<>
			<dt>{props.label}</dt>
			<dd classList={{ mono: props.mono === true }}>{props.value.length === 0 ? "—" : props.value}</dd>
		</>
	);
}
