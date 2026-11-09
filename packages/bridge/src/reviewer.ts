import { spawn, type ChildProcess } from "node:child_process";
import type { ReviewRunnerView } from "@gentle-shell/protocol";
import { resolvePiEnvironment } from "./pi-environment.ts";

/**
 * One reviewer run: a throwaway `pi` process that reads a lens context and answers in prose.
 *
 * The panel must never run a prompt inside the user's open thread — that would spend their context and
 * drop review output into their transcript — so the reviewer lives in a process of its own and dies
 * with it:
 * - `--print` is the documented non-interactive mode ("process prompt and exit"), and `--no-session`
 *   is the documented "don't save session (ephemeral)", so a run leaves nothing in the agent home.
 * - The prompt goes on argv, because `pi --help` documents the message as a positional argument and
 *   documents no stdin prompt source at all. `--` ends option parsing, which is the help's own recipe
 *   for a message that begins with a dash. Every element is passed separately: no shell string exists,
 *   so no token of a lens context can be re-read as one.
 * - Nothing here reads a session, a thread or a socket: the only inputs are the model and the context.
 *   The reviewer is not RPC; it prints and exits.
 */

/** A lens context is read by a model: minutes, not milliseconds, but never unbounded. */
export const DEFAULT_REVIEWER_TIMEOUT_MS = 300_000;
/** Captured verdict text stops here, so one runaway answer cannot fill the bridge's memory. */
export const MAX_REVIEWER_TEXT_CHARS = 200_000;

export interface ReviewerRequest {
	/** The model the user already selected; empty is refused rather than defaulted. */
	readonly model: string;
	/** The provider's own lens context, relayed whole as the prompt. */
	readonly context: string;
}

export interface ReviewerOptions {
	/** Executable that runs Pi. Defaults to `pi` on PATH; tests point this at a fake. */
	readonly executable?: string;
	readonly env?: Readonly<Record<string, string>>;
	/** Where the run happens. Defaults to the bridge's own working directory (its workspace). */
	readonly cwd?: string;
	readonly timeoutMs?: number;
	readonly maxTextChars?: number;
}

/** The exact argv a reviewer run uses, in order, with the context last and unterminated by a flag. */
export function reviewerArgv(model: string, context: string): readonly string[] {
	return ["--print", "--no-session", "--model", model, "--", context];
}

/**
 * Run one reviewer and answer what it said.
 *
 * A non-zero exit is an answer, not a transport failure: the panel shows the text and the code. A run
 * that outlives its timeout is a failure, because empty text would read as "the reviewer had nothing
 * to say".
 */
export async function runReviewer(request: ReviewerRequest, options: ReviewerOptions = {}): Promise<ReviewRunnerView> {
	const model = request.model.trim();
	if (model.length === 0) throw new Error("a reviewer run needs a model; no process was started");

	const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
	const maxTextChars = options.maxTextChars ?? MAX_REVIEWER_TEXT_CHARS;
	const executable = options.executable ?? "pi";
	const startedAt = Date.now();

	return new Promise<ReviewRunnerView>((resolve, reject) => {
		const child = spawn(executable, [...reviewerArgv(model, request.context)], {
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			env: reviewerEnvironment(options),
			// The prompt is an argument, so stdin is never written: an ignored stream cannot leave a
			// child waiting on a pipe this side forgot to close.
			stdio: ["ignore", "pipe", "pipe"],
			// Own process group on POSIX, so the timeout kills what the run started, not only the first
			// pid; on Windows the tree kill is `taskkill /T` instead.
			detached: process.platform !== "win32",
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let truncated = false;
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, timeoutMs);

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		// Retained text stops at the cap; the stream is still drained so the child can finish and exit.
		child.stdout?.on("data", (chunk: string) => {
			if (truncated) return;
			if (stdout.length + chunk.length <= maxTextChars) {
				stdout += chunk;
				return;
			}
			stdout += chunk.slice(0, Math.max(0, maxTextChars - stdout.length));
			truncated = true;
		});
		child.stderr?.on("data", (chunk: string) => {
			if (stderr.length < maxTextChars) stderr = (stderr + chunk).slice(0, maxTextChars);
		});

		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new Error(`the reviewer could not start ${executable} (${error.message})`));
		});

		// `close`, not `exit`: it fires once the streams are drained, so the text is complete.
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`the reviewer did not finish within ${timeoutMs} ms and was stopped`));
				return;
			}
			// stdout is the verdict; stderr is what a run that printed none has to say instead.
			const said = stdout.trim();
			resolve({
				text: said.length > 0 ? said : stderr.trim(),
				// A run killed by a signal has no exit code; -1 is this side's own "it did not answer".
				exitCode: code ?? -1,
				durationMs: Date.now() - startedAt,
				truncated,
			});
		});
	});
}

/**
 * The environment the reviewer runs in.
 *
 * `PI_CODING_AGENT_DIR` defaults to the same agent home the threads use, because that is where the
 * user's models and credentials are declared: a reviewer on another home would resolve a different
 * catalog. `--no-session` is what keeps this run from writing there.
 */
function reviewerEnvironment(options: ReviewerOptions): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env, ...options.env };
	if (env["PI_CODING_AGENT_DIR"] === undefined) {
		env["PI_CODING_AGENT_DIR"] = resolvePiEnvironment().env["PI_CODING_AGENT_DIR"];
	}
	return env;
}

/** Kill the whole run: its process group on POSIX, its tree through `taskkill` on Windows. */
function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined) return;

	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// The group is already gone, or the child never led one: kill what is left by pid.
		child.kill("SIGKILL");
	}
}
