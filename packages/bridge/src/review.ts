import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
	ReviewAssessment,
	ReviewAuthority,
	ReviewCollectInput,
	ReviewConsent,
	ReviewConsentChoice,
	ReviewExecuteStep,
	ReviewFrozen,
	ReviewMode,
	ReviewStartView,
	ReviewStatusView,
	ReviewTransition,
	ReviewTransitionKind,
} from "@gentle-shell/protocol";
import { defaultExtensionCandidates, resolvePiEnvironment } from "./pi-environment.ts";

/**
 * Native review (receipt-driven development) — the observation half.
 *
 * The provider is an external binary (`gentle-ai`) that this bridge runs with an argv array and never
 * through a shell. Its lifecycle is transition-driven: `review status` is asked first, and whatever it
 * reports is what this module acts on. Tokens are never synthesized because a start without its own
 * status tokens mismatches the target identity the authority froze.
 *
 * Three rules are load-bearing:
 * - A START always carries `--consent relay`. Without it a non-TTY start reviews the change without
 *   asking and only prints a warning on stderr, which a desktop client must never do.
 * - A consent answer replays the exact invocation the provider handed out, and only when it names this
 *   binary and answers consent. Anything else is refused before a process exists.
 * - Nothing is read from `.git/gentle-ai/…` as authority. Those artefacts name a lineage; the status of
 *   that lineage is the only thing allowed to say what the authority is.
 *
 * Maintenance verbs (abandon, recover, reclaim, quarantine-legacy, reconcile-authority,
 * repair-legacy-alias) need multi-line authorization bindings and are deliberately absent: they belong
 * to a maintainer, and the panel reports that instead of attempting them.
 */

/** The negotiation this bridge speaks; the provider echoes it on every answer. */
export const REVIEW_CONTRACT = "gentle-ai.review-integration/v1";
/** The candidate projection the panel reviews: the working tree, not a post-commit staged tree. */
export const REVIEW_PROJECTION = "workspace";
/** Absolute path to the provider; the only sanctioned way to override the discovered binary. */
export const REVIEW_BINARY_ENV = "GENTLE_SHELL_REVIEW_BINARY";
/** The provider's own field-test override, honoured so a dev binary is never silently ignored. */
const DEV_BINARY_ENV = "GENTLE_PI_GENTLE_AI_DEV_BINARY";
/** A status or an assessment answers in milliseconds; a start freezes trees and takes longer. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** How many recorded lineages are asked about before the panel settles for no authority. */
const MAX_LINEAGE_PROBES = 5;

const NO_AUTHORITY_MESSAGE = "The provider has no review authority for this workspace yet.";

export interface ReviewOptions {
	/** Absolute path to the provider. Tests point this at a fake script. */
	readonly binary?: string;
	/**
	 * A `gentle-pi` package root to look in first. The bridge knows which package it launches Pi with, and
	 * the review provider should be that same install's binary rather than whichever one is found first.
	 */
	readonly packageRoot?: string;
	readonly timeoutMs?: number;
	readonly env?: Readonly<Record<string, string>>;
}

export interface ReviewConsentOptions extends ReviewOptions {
	/** Repository the replayed command runs in; the invocation's own `--cwd` still wins for the provider. */
	readonly cwd?: string;
}

interface ReviewRun {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
}

/**
 * Where the provider lives.
 *
 * Pi requires an absolute path to `gentle-ai`, so a discovered binary is always returned absolute. The
 * order is: an explicit path, the two documented environment overrides, the `gentle-pi` package that is
 * actually loaded, the standard package locations, and finally PATH — resolved to an absolute path,
 * never left as a bare name.
 */
export function resolveReviewBinary(options: ReviewOptions = {}): string {
	const env = options.env ?? process.env;
	const explicit = options.binary ?? env[REVIEW_BINARY_ENV] ?? env[DEV_BINARY_ENV];
	if (explicit !== undefined && explicit.trim().length > 0) return requireAbsoluteBinary(explicit.trim());

	for (const root of packageRoots(options)) {
		const found = binaryInPackage(root);
		if (found !== null) return found;
	}

	const onPath = binaryOnPath(env["PATH"] ?? env["Path"] ?? "");
	if (onPath !== null) return onPath;

	throw new Error(
		`the Gentle AI review binary was not found. Set ${REVIEW_BINARY_ENV} to the absolute path of gentle-ai.`,
	);
}

/** STATUS, with the canonical next transition, and the raw text kept when it cannot be parsed. */
export async function reviewStatus(root: string, options: ReviewOptions = {}): Promise<ReviewStatusView> {
	const gitDir = await gitDirectory(root);
	if (gitDir === null) {
		return emptyStatus(
			root,
			"not-a-repository",
			"This workspace is not a git repository, so there is no review authority to read.",
		);
	}

	const binary = resolveReviewBinary(options);
	const plain = parseReviewStatus(await runJson(binary, statusArgv(root, null), root, options), root);
	// An answer that already carries an authority, or that did not parse at all, is the whole story.
	if (plain.state !== "ok" || plain.authority !== null) return plain;

	// The provider only reports an authority when it is asked about one lineage, and the ids it accepts
	// are recorded under the shared git directory. They are read here only to name a lineage; the status
	// of that lineage is what says whether it is authoritative, and how.
	let stale: ReviewAuthority | null = null;
	for (const lineage of recentLineages(gitDir)) {
		let answer: string;
		try {
			answer = await runJson(binary, statusArgv(root, lineage), root, options);
		} catch {
			// A lineage the provider no longer knows is not a panel failure: it simply is not authority.
			continue;
		}
		const view = parseReviewStatus(answer, root);
		if (view.state !== "ok" || view.authority === null) continue;
		if (view.targetIdentity === plain.targetIdentity) return view;
		stale ??= view.authority;
	}

	if (stale === null) return plain;
	return {
		...plain,
		authority: stale,
		authorityStale: true,
		message: "The review authority on record belongs to an earlier target than the changes here.",
	};
}

/** The read-only risk a start would freeze. */
export async function reviewAssess(
	root: string,
	options: ReviewOptions = {},
	baseRef?: string,
): Promise<ReviewAssessment> {
	const raw = await runJson(resolveReviewBinary(options), assessArgv(root, baseRef), root, options);
	const record = asRecord(parseJson(raw));
	if (record === null) {
		throw new Error(`the provider answered review assess with text that is not the JSON this panel reads: ${excerpt(raw)}`);
	}

	const candidate = asRecord(record.candidate);
	return {
		risk: text(record.risk) ?? "",
		reasons: records(record.reasons)
			.map((entry) => ({ code: text(entry.code) ?? "", path: text(entry.path) }))
			.filter((entry) => entry.code.length > 0),
		changedPaths: count(record.changed_paths),
		changedLines: count(record.changed_lines),
		candidateKind: text(candidate?.kind) ?? "",
		candidateConsumed: candidate?.consumed === true,
		reviewDue: record.review_due === true,
		reviewDueReason: text(record.review_due_reason) ?? "",
	};
}

/** The user-owned kill switch, with both sources and which one decided. */
export async function reviewModeStatus(root: string, options: ReviewOptions = {}): Promise<ReviewMode> {
	const raw = await runJson(resolveReviewBinary(options), modeArgv(root), root, options);
	const record = asRecord(parseJson(raw));
	const status = asRecord(record?.status);
	if (status === null) {
		throw new Error(`the provider answered review mode status with text that is not the JSON this panel reads: ${excerpt(raw)}`);
	}

	return {
		global: text(status.global) ?? "",
		cloneLocal: text(status.clone_local) ?? "",
		effective: text(status.effective) ?? "",
		source: text(status.source) ?? "",
		revision: text(status.revision) ?? "",
	};
}

/**
 * START a review with the tokens its own status transition carried.
 *
 * The token list is the provider's, never built here: an empty list is refused, a token that answers
 * consent is refused, and `--consent relay` is appended so the provider always asks instead of assuming.
 */
export async function reviewStart(
	root: string,
	tokens: readonly string[],
	options: ReviewOptions = {},
): Promise<ReviewStartView> {
	const argv = startArgv(tokens, root);
	return parseStart(await runJson(resolveReviewBinary(options), argv, root, options));
}

/**
 * Answer the blocking consent question.
 *
 * The provider hands out one exact command line per answer; replaying it is the only honest way to
 * consent. The line is split into argv (never handed to a shell), its program must be this bridge's
 * resolved binary, its verb must be a review start, and it must answer consent exactly once.
 */
export async function answerConsent(
	invocation: string,
	options: ReviewConsentOptions = {},
): Promise<ReviewStartView> {
	const binary = resolveReviewBinary(options);
	const argv = splitInvocation(invocation);
	const program = argv[0] ?? "";
	// The provider renders its own program name rather than an absolute path, so that one name is
	// accepted and then replaced by the resolved binary. Every other program is refused.
	if (program !== binary && program !== "gentle-ai") {
		throw new Error(`the consent invocation does not start with the resolved review binary (${binary}): ${program}`);
	}

	const verb = argv.slice(1);
	if (verb[0] !== "review" || verb[1] !== "start") {
		throw new Error(`the consent invocation is not a review start command: ${verb.slice(0, 2).join(" ") || "empty"}`);
	}

	const answers = consentAnswers(verb);
	if (answers.length === 0) {
		throw new Error("the consent invocation does not answer consent, so replaying it would prove nothing");
	}
	if (answers.length > 1) throw new Error("the consent invocation answers consent more than once");
	const answer = answers[0] ?? "";
	if (answer !== "granted" && answer !== "declined") {
		throw new Error(`the consent invocation answers "${answer}", which this panel never sends; only granted and declined can be replayed`);
	}

	return parseStart(await runJson(binary, verb, options.cwd, options));
}

/**
 * Split a command line into argv the way a shell would, without ever running one.
 *
 * Single quotes keep everything literal, double quotes keep everything but a backslash escape, and an
 * unterminated quote is an error instead of a guess: a half-read invocation must never be replayed.
 */
export function splitInvocation(line: string): string[] {
	const argv: string[] = [];
	let current = "";
	let quoting: '"' | "'" | null = null;
	let started = false;

	for (let index = 0; index < line.length; index += 1) {
		const char = line[index] ?? "";
		if (char === "\0") throw new Error("the consent invocation carries a NUL byte");

		if (quoting === null && (char === " " || char === "\t" || char === "\n")) {
			if (started) {
				argv.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		if (quoting === null && (char === '"' || char === "'")) {
			quoting = char;
			started = true;
			continue;
		}
		if (quoting !== null && char === quoting) {
			quoting = null;
			started = true;
			continue;
		}
		if (char === "\\" && quoting !== "'") {
			const escaped = line[index + 1];
			if (escaped !== undefined) {
				current += escaped;
				started = true;
				index += 1;
				continue;
			}
		}
		current += char;
		started = true;
	}

	if (quoting !== null) {
		throw new Error(`the consent invocation has an unterminated ${quoting === '"' ? "double" : "single"} quote`);
	}
	if (started) argv.push(current);
	return argv;
}

/**
 * Project one `review status` answer.
 *
 * Exported because the projection is the whole contract of this panel: what is not in the provider's
 * answer cannot appear in the UI. An unparseable answer, or an execute transition with no usable tokens,
 * becomes `unreadable` with the raw text attached rather than a fabricated state.
 */
export function parseReviewStatus(raw: string, repository: string): ReviewStatusView {
	const record = asRecord(parseJson(raw));
	if (record === null) {
		return unreadableStatus(repository, raw, "the provider answered review status with text that is not the JSON this panel reads");
	}

	const schema = text(record.schema);
	if (schema === null || !schema.startsWith("gentle-ai.review-integration.status/")) {
		return unreadableStatus(
			repository,
			raw,
			`the provider answered review status with ${schema === null ? "no schema" : schema}, which this panel does not read`,
		);
	}

	const transition = parseTransition(record.next_transition);
	if (transition.ok === false) return unreadableStatus(repository, raw, transition.message);

	const authority = parseAuthority(record.authority);
	const projection = asRecord(record.projection);
	return {
		state: "ok",
		emptiness: authority === null ? "no-authority" : null,
		message:
			authority === null
				? NO_AUTHORITY_MESSAGE
				: `The authority is ${authority.state} at generation ${authority.generation}.`,
		repository,
		contract: text(record.contract) ?? REVIEW_CONTRACT,
		applicability: text(record.applicability) ?? "",
		action: text(record.action) ?? "",
		targetIdentity: text(record.target_identity) ?? "",
		projection: text(projection?.projection) ?? "",
		changedPaths: strings(projection?.paths),
		authority,
		authorityStale: false,
		frozen: parseFrozen(record.frozen),
		transition: transition.transition,
		raw: null,
	};
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function statusArgv(root: string, lineage: string | null): string[] {
	const argv = ["review", "status", "--contract", REVIEW_CONTRACT, "--cwd", root, "--projection", REVIEW_PROJECTION];
	if (lineage !== null) argv.push("--lineage", lineage);
	argv.push("--next-transition");
	return argv;
}

/**
 * `review assess`, optionally against a base commit.
 *
 * With nothing uncommitted the provider answers that the candidate has no pending changes and names
 * `--base-ref` as the way to assess committed work. That ref arrives from the panel, so it is checked
 * here: a value that could be read as another option is refused rather than forwarded.
 */
function assessArgv(root: string, baseRef?: string): string[] {
	const argv = ["review", "assess", "--cwd", root, "--json"];
	if (baseRef === undefined) return argv;
	const ref = baseRef.trim();
	if (ref.length === 0) throw new Error("a base ref must name a commit, not be empty");
	if (ref.startsWith("-") || /\s/.test(ref)) {
		throw new Error(`the base ref ${JSON.stringify(ref)} is not a single commit reference`);
	}
	argv.push("--base-ref", ref);
	return argv;
}

function modeArgv(root: string): string[] {
	return ["review", "mode", "status", "--cwd", root, "--json"];
}

/** The policy of a start, in one place: provider tokens in, relay appended, nothing else. */
function startArgv(tokens: readonly string[], root: string): string[] {
	if (!Array.isArray(tokens) || tokens.length === 0) {
		throw new Error("a review start needs the tokens its status transition provided");
	}
	for (const token of tokens) {
		if (typeof token !== "string" || !token.startsWith("--") || token.includes("\0")) {
			throw new Error(`the review token ${JSON.stringify(token)} is not a --flag and will not be forwarded`);
		}
		if (token === "--consent" || token.startsWith("--consent=")) {
			throw new Error("the review tokens must not answer consent; the panel always relays it");
		}
		// The renderer is untrusted input: a token must not be able to point the review at another repo.
		if (token.startsWith("--cwd=") && !sameRoot(token.slice("--cwd=".length), root)) {
			throw new Error(`the review token targets a different workspace: ${token.slice("--cwd=".length)}`);
		}
	}
	return ["review", "start", ...tokens, "--consent", "relay"];
}

/** Compare two paths as workspaces, tolerating a trailing slash and a relative form. */
function sameRoot(candidate: string, root: string): boolean {
	const normalise = (value: string): string => {
		const absolute = isAbsolute(value) ? value : resolve(root, value);
		return absolute.replace(/[\\/]+$/, "");
	};
	return normalise(candidate) === normalise(root);
}

/** Every `--consent` value in an argv, whether written as a pair or with an equals sign. */
function consentAnswers(argv: readonly string[]): string[] {
	const answers: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--consent") {
			answers.push(argv[index + 1] ?? "");
			index += 1;
			continue;
		}
		if (arg.startsWith("--consent=")) answers.push(arg.slice("--consent=".length));
	}
	return answers;
}

// ---------------------------------------------------------------------------
// running the provider
// ---------------------------------------------------------------------------

async function runJson(
	binary: string,
	argv: readonly string[],
	cwd: string | undefined,
	options: ReviewOptions,
): Promise<string> {
	const result = await runCli(binary, argv, cwd, options);
	if (result.code !== 0) throw commandFailure(argv, result);
	return result.stdout;
}

/** Spawn the provider with an argv array. A shell string is never built, so no token can be re-read. */
function runCli(
	binary: string,
	argv: readonly string[],
	cwd: string | undefined,
	options: ReviewOptions,
): Promise<ReviewRun> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
	return new Promise<ReviewRun>((resolve, reject) => {
		execFile(
			binary,
			[...argv],
			{
				...(cwd === undefined ? {} : { cwd }),
				timeout: timeoutMs,
				maxBuffer: MAX_OUTPUT_BYTES,
				windowsHide: true,
				encoding: "utf8",
				env: { ...process.env, ...options.env },
			},
			(error, stdout, stderr) => {
				if (error === null) {
					resolve({ stdout, stderr, code: 0 });
					return;
				}

				const failure = error as NodeJS.ErrnoException & { readonly killed?: boolean };
				if (failure.killed === true) {
					reject(new Error(`the review command "${commandLabel(argv)}" did not finish within ${timeoutMs} ms`));
					return;
				}
				if (typeof failure.code === "string") {
					reject(new Error(`the review binary at ${binary} could not be started (${failure.code})`));
					return;
				}
				// A non-zero exit is an answer, not a transport failure: the caller decides how to say it.
				resolve({ stdout, stderr, code: typeof failure.code === "number" ? failure.code : -1 });
			},
		);
	});
}

/** Say exactly what the provider said: its failure envelope first, then stderr, then stdout. */
function commandFailure(argv: readonly string[], result: ReviewRun): Error {
	const detail =
		failureEnvelope(result.stdout) ??
		firstLine(result.stderr) ??
		firstLine(result.stdout) ??
		"the provider printed nothing";
	return new Error(`${commandLabel(argv)} failed (exit ${result.code}): ${detail}`);
}

/** The provider's own machine-readable failure, which is more precise than its stderr line. */
function failureEnvelope(stdout: string): string | null {
	const record = asRecord(parseJson(stdout));
	if (record === null) return null;
	const schema = text(record.schema);
	if (schema === null || !schema.includes("failure")) return null;
	const message = text(record.message);
	if (message === null) return null;
	const code = text(record.code);
	return code === null ? message : `${message} [${code}]`;
}

function commandLabel(argv: readonly string[]): string {
	// Program name is implied: every command here is `gentle-ai`.
	return argv.slice(0, 2).join(" ");
}

// ---------------------------------------------------------------------------
// git and the recorded lineages
// ---------------------------------------------------------------------------

/** The shared git directory, which is where the provider keeps its lineages; null outside a repository. */
function gitDirectory(root: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", root, "rev-parse", "--absolute-git-dir"],
			{ timeout: 10_000, windowsHide: true, encoding: "utf8" },
			(error, stdout) => {
				if (error !== null) {
					resolve(null);
					return;
				}
				const value = stdout.trim();
				resolve(value.length === 0 ? null : value);
			},
		);
	});
}

/**
 * Lineage ids recorded in the repository, newest first.
 *
 * Only names are read: the artefacts under each directory are for a human to inspect, and the status of
 * a lineage is what decides whether it is authority.
 */
function recentLineages(gitDir: string): readonly string[] {
	const directory = join(gitDir, "gentle-ai", "review-transactions", "v2");
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}

	const entries: { readonly name: string; readonly at: number }[] = [];
	for (const name of names) {
		try {
			const stats = statSync(join(directory, name));
			if (stats.isDirectory()) entries.push({ name, at: stats.mtimeMs });
		} catch {
			// A directory that vanished between listing and stat was never a lineage to report.
		}
	}

	return entries
		.sort((left, right) => right.at - left.at)
		.slice(0, MAX_LINEAGE_PROBES)
		.map((entry) => entry.name);
}

// ---------------------------------------------------------------------------
// binary discovery
// ---------------------------------------------------------------------------

function requireAbsoluteBinary(path: string): string {
	if (!isAbsolute(path)) {
		throw new Error(`the review binary must be an absolute path, received "${path}"; a bare name would be a PATH lookup, not an identity`);
	}
	if (!existsSync(path)) throw new Error(`the review binary at ${path} does not exist`);
	if (!statSync(path).isFile()) throw new Error(`the review binary at ${path} is not a file`);
	return path;
}

/** Package roots to look in, most-specific first: the named package, the loaded one, then the installs. */
function packageRoots(options: ReviewOptions = {}): readonly string[] {
	const roots: string[] = [];
	if (options.packageRoot !== undefined && options.packageRoot.trim().length > 0) {
		roots.push(realpathOf(options.packageRoot.trim()));
	}
	const extension = resolvePiEnvironment().extensionPath;
	if (extension !== null) roots.push(extension);
	for (const candidate of defaultExtensionCandidates()) roots.push(realpathOf(candidate));
	return [...new Set(roots)];
}

/** `<package>/.gentle-ai/v<version>/gentle-ai`, newest installed version first. */
function binaryInPackage(root: string): string | null {
	const runtime = join(root, ".gentle-ai");
	let versions: string[];
	try {
		versions = readdirSync(runtime);
	} catch {
		return null;
	}

	const name = process.platform === "win32" ? "gentle-ai.exe" : "gentle-ai";
	for (const version of [...versions].sort(compareVersions).reverse()) {
		const candidate = join(runtime, version, name);
		if (isFile(candidate)) return candidate;
	}
	return null;
}

/** Last resort: a PATH entry, but returned absolute so it is still an identity and not a lookup. */
function binaryOnPath(path: string): string | null {
	const name = process.platform === "win32" ? "gentle-ai.exe" : "gentle-ai";
	for (const entry of path.split(process.platform === "win32" ? ";" : ":")) {
		if (entry.length === 0) continue;
		const candidate = join(entry, name);
		if (isFile(candidate)) return candidate;
	}
	return null;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function realpathOf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Version-aware ordering so `v4.10.0` sorts above `v4.9.0`. */
function compareVersions(left: string, right: string): number {
	const leftParts = left.match(/\d+|\D+/g) ?? [left];
	const rightParts = right.match(/\d+|\D+/g) ?? [right];
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const a = leftParts[index] ?? "";
		const b = rightParts[index] ?? "";
		const aNumber = Number.parseInt(a, 10);
		const bNumber = Number.parseInt(b, 10);
		if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
			if (aNumber !== bNumber) return aNumber - bNumber;
			continue;
		}
		if (a !== b) return a < b ? -1 : 1;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// projection helpers
// ---------------------------------------------------------------------------

type TransitionResult =
	| { readonly ok: true; readonly transition: ReviewTransition | null }
	| { readonly ok: false; readonly message: string };

function parseTransition(value: unknown): TransitionResult {
	if (value === undefined || value === null) return { ok: true, transition: null };
	const record = asRecord(value);
	if (record === null) return { ok: false, message: "the provider's next transition is not an object" };

	const kind = text(record.kind);
	if (kind !== "execute" && kind !== "collect" && kind !== "stop") {
		return { ok: false, message: `the provider's next transition has kind "${kind ?? ""}", which this panel does not know` };
	}

	const transition: ReviewTransition = {
		kind: kind as ReviewTransitionKind,
		reasonCode: text(record.reason_code) ?? "",
		execute: kind === "execute" ? parseExecute(record.execute) : null,
		collect: kind === "collect" ? parseCollect(record.collect) : [],
	};
	if (kind === "execute" && transition.execute === null) {
		return { ok: false, message: "the provider's execute transition carries no usable --tokens, so it cannot be offered" };
	}
	return { ok: true, transition };
}

/** The tokens are the provider's; they are kept verbatim because a rewritten token breaks the identity. */
function parseExecute(value: unknown): ReviewExecuteStep | null {
	const record = asRecord(value);
	if (record === null) return null;

	const argumentsList = records(record.arguments);
	const tokens: string[] = [];
	for (const entry of argumentsList) {
		const token = text(entry.token);
		if (token === null || !token.startsWith("--")) return null;
		tokens.push(token);
	}
	if (tokens.length === 0) return null;

	const binding = asRecord(record.binding);
	return {
		operation: text(record.operation) ?? "",
		command: text(record.command) ?? "",
		tokens,
		lineageId: text(binding?.lineage_id),
		targetIdentity: text(binding?.target_identity),
	};
}

function parseCollect(value: unknown): readonly ReviewCollectInput[] {
	const record = asRecord(value);
	if (record === null) return [];
	return records(record.inputs).map((entry) => ({
		name: text(entry.name) ?? "",
		schema: text(entry.schema) ?? "",
		captureOperation: text(entry.capture_operation) ?? "",
	}));
}

/**
 * An authority the panel can render, or null.
 *
 * A block without a lineage id cannot be shown as an authority, so it is treated as absent: the panel
 * then says it has no authority, which is true of everything it can display.
 */
function parseAuthority(value: unknown): ReviewAuthority | null {
	const record = asRecord(value);
	if (record === null) return null;
	const lineageId = text(record.lineage_id);
	if (lineageId === null) return null;
	return {
		version: text(record.version) ?? "",
		lineageId,
		state: text(record.state) ?? "",
		generation: count(record.generation),
		revision: text(record.revision) ?? "",
	};
}

function parseFrozen(value: unknown): ReviewFrozen | null {
	const record = asRecord(value);
	if (record === null) return null;
	return {
		tier: text(record.tier) ?? "",
		changedLines: count(record.original_changed_lines),
		correctionBudget: count(record.correction_budget),
		changedPathManifestDigest: text(record.changed_path_manifest_sha256) ?? "",
	};
}

function parseStart(raw: string): ReviewStartView {
	const record = asRecord(parseJson(raw));
	if (record === null) {
		throw new Error(`the provider answered review start with text that is not the JSON this panel reads: ${excerpt(raw)}`);
	}

	const consent = parseConsent(record);
	if (consent !== null) {
		return {
			outcome: "consent",
			consent,
			lineageId: "",
			state: "",
			riskLevel: consent.riskLevel,
			selectedLenses: [],
			changedFiles: consent.changedFiles,
			changedLines: consent.changedLines,
			correctionBudget: 0,
			message: consent.headline,
		};
	}

	const lineageId = text(record.lineage_id) ?? "";
	const base = {
		consent: null,
		lineageId,
		state: text(record.state) ?? "",
		riskLevel: text(record.risk_level) ?? "",
		selectedLenses: strings(record.selected_lenses),
		changedFiles: count(record.changed_files),
		changedLines: count(record.changed_lines),
		correctionBudget: count(record.correction_budget),
	};

	const action = text(record.action) ?? "";
	if (action === "created") {
		return { ...base, outcome: "started", message: `Review started for lineage ${lineageId}.` };
	}
	if (action === "declined") {
		return { ...base, outcome: "declined", message: "The change was skipped; no review record was created." };
	}
	throw new Error(`the provider answered review start with action "${action}", which this panel does not know`);
}

/**
 * The typed consent envelope, or null when the answer is not one.
 *
 * Strict on purpose: two ordered choices with readable invocations, or an error. A card that cannot
 * offer both answers would be a dead end for the user.
 */
function parseConsent(record: Record<string, unknown>): ReviewConsent | null {
	if (!Array.isArray(record.choices)) return null;

	const schema = text(record.schema) ?? "";
	if (!/^gentle-ai\.review-integration\.consent\/v\d+$/.test(schema)) {
		throw new Error(`the provider's consent envelope declares schema "${schema}", which this panel does not read`);
	}

	const choices = record.choices.map(consentChoiceOf);
	if (choices.length !== 2) {
		throw new Error(`the provider's consent envelope must offer exactly two choices, it offered ${choices.length}`);
	}

	return {
		schema,
		blocking: record.blocking === true,
		targetIdentity: text(record.target_identity) ?? "",
		projection: text(record.projection) ?? "",
		riskLevel: text(record.risk_level) ?? "",
		changedFiles: count(record.changed_files),
		changedLines: count(record.changed_lines),
		headline: text(record.headline) ?? "",
		reason: text(record.reason) ?? "",
		value: text(record.value) ?? "",
		riskEvidence: strings(record.risk_evidence),
		choices,
		offPath: parseOffPath(record.off_path),
	};
}

function consentChoiceOf(entry: unknown): ReviewConsentChoice {
	const record = asRecord(entry);
	const answer = text(record?.answer);
	const invocation = text(record?.invocation);
	if (record === null || answer === null || invocation === null) {
		throw new Error("the provider's consent envelope carries a choice without an answer or an invocation");
	}

	let argv: string[];
	try {
		argv = splitInvocation(invocation);
	} catch (error) {
		throw new Error(`the provider's consent choice "${answer}" carries an invocation that cannot be read: ${errorMessage(error)}`);
	}
	if (!argv.some((arg) => arg === "--consent" || arg.startsWith("--consent="))) {
		throw new Error(`the provider's consent choice "${answer}" does not answer consent`);
	}

	return {
		answer,
		label: text(record.label) ?? answer,
		effect: text(record.effect) ?? "",
		invocation,
	};
}

function parseOffPath(value: unknown): { readonly note: string; readonly command: string } | null {
	const record = asRecord(value);
	if (record === null) return null;
	const note = text(record.note);
	const command = text(record.command);
	if (note === null || command === null) return null;
	return { note, command };
}

function emptyStatus(
	repository: string,
	emptiness: ReviewStatusView["emptiness"],
	message: string,
): ReviewStatusView {
	return {
		state: "empty",
		emptiness,
		message,
		repository,
		contract: REVIEW_CONTRACT,
		applicability: "",
		action: "",
		targetIdentity: "",
		projection: "",
		changedPaths: [],
		authority: null,
		authorityStale: false,
		frozen: null,
		transition: null,
		raw: null,
	};
}

function unreadableStatus(repository: string, raw: string, message: string): ReviewStatusView {
	return {
		state: "unreadable",
		emptiness: null,
		message,
		repository,
		contract: REVIEW_CONTRACT,
		applicability: "",
		action: "",
		targetIdentity: "",
		projection: "",
		changedPaths: [],
		authority: null,
		authorityStale: false,
		frozen: null,
		transition: null,
		raw,
	};
}

// ---------------------------------------------------------------------------
// small readers
// ---------------------------------------------------------------------------

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function records(value: unknown): readonly Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null);
}

/** A trimmed non-empty string, or null: an empty string in the provider's answer means "not said". */
function text(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function strings(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.map(text).filter((entry): entry is string => entry !== null);
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function firstLine(value: string): string | null {
	const line = value
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	return line ?? null;
}

function excerpt(value: string): string {
	return firstLine(value) ?? "no output";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
