import { createHash, randomBytes } from "node:crypto";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { ConfigFailureReason } from "@gentle-shell/protocol";

/**
 * Writing a configuration file behind a confirmation the UI showed.
 *
 * Every settings family (`packages` today, MCP and `settings.json` keys next) needs the same four
 * guarantees, and they live here so no family can get them subtly wrong:
 *
 * 1. **Nothing happens without a confirmation.** `preview` computes a canonical plan
 *    `{ operation, target, before, after }` and the sha256 of its canonical JSON. `apply` requires that
 *    digest, recomputes the plan from the same request and compares. The digest is the contract: the
 *    bridge is reachable by every local process that holds its token, so a write that a person did not
 *    confirm must be impossible, not merely unlikely.
 *
 * 2. **A plan is used once.** A plan says what the file holds *now* and what it should hold, so once it
 *    has been applied its digest is spent: repeating it is `stale-plan`, never a second write. A plan
 *    the caller never previewed is refused the same way.
 *
 * 3. **A file that changed in between is not overwritten.** If the target no longer holds the bytes the
 *    preview saw — the terminal, Pi itself or another writer got there first — the answer is
 *    `changed-on-disk` and the file is left alone.
 *
 * 4. **The previous bytes survive the write.** Before replacing content that differs from what this
 *    process last wrote, the old bytes are copied to `<configHome>/<family>-backups/<file>-<timestamp>`,
 *    the same idea `profiles.ts` uses for `profiles-backups`. The write itself is atomic (a temp file in
 *    the same folder, then a rename) and `0600`.
 *
 * Two smaller rules come from the files being someone else's. An unreadable or unparsable target is
 * `file-invalid` — the write refuses and the file is never replaced by the plan, matching C2. And the
 * file keeps its own shape: the plan is serialized with the indentation already on disk and the final
 * newline it already had, so editing one entry does not reformat the whole file.
 *
 * The change itself belongs to the family: this module knows a target, a request and a digest, and
 * nothing about Pi, packages or MCP. The family also decides the lock, when the file has one.
 */

/** JSON as a configuration file holds it: the shape every plan and change is expressed in. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object, which is the only shape a settings file may have. */
export type JsonObject = { [key: string]: JsonValue };

/** The target as it is on disk when a plan is computed. */
export interface ConfigFileState {
	/** The exact text, or null when the file does not exist yet. */
	readonly text: string | null;
	/** The parsed object, or null when the file does not exist yet. */
	readonly value: JsonObject | null;
}

/** What a family decides: the whole new content, and the lines the confirmation shows. */
export interface ConfigChange {
	readonly next: JsonObject;
	readonly summary: readonly string[];
}

/** What a family asks this module to write. */
export interface ConfigWriteRequest {
	/** Names the change, e.g. `packages.install`; it is part of the digest. */
	readonly operation: string;
	/** Names the backup folder: `<configHome>/<family>-backups`. */
	readonly family: string;
	/** The absolute path of the file to write; part of the digest too. */
	readonly path: string;
	/** The change, computed from the file's current content. It must not write anything. */
	readonly change: (current: ConfigFileState) => ConfigChange | Promise<ConfigChange>;
	/** The file's own lock, when another writer has one; the check-and-write runs inside it. */
	readonly lock?: (run: () => void) => void;
}

/** The canonical plan: exactly the four fields the digest covers. */
export interface ConfigPlan {
	readonly operation: string;
	readonly target: string;
	/** The file's text as the preview saw it, or null when it did not exist. */
	readonly before: string | null;
	/** The text the write would leave on disk, byte for byte. */
	readonly after: string;
}

export interface ConfigPreviewResult {
	readonly plan: ConfigPlan;
	readonly digest: string;
	readonly summary: readonly string[];
	/** The plan's content, already parsed, so an apply does not parse it a second time. */
	readonly next: JsonObject;
}

export interface ConfigApplyResult extends ConfigPreviewResult {
	/** Where the bytes this write replaced were kept; null when there was nothing to keep. */
	readonly backup: string | null;
}

export interface ConfigWriteOptions {
	/** Gentle Shell's config home: backups live under it, never next to the file being written. */
	readonly configHome: string;
	readonly now?: () => Date;
}

/** A write that was refused, with a reason a panel can name. */
export class ConfigWriteError extends Error {
	readonly reason: ConfigFailureReason;

	constructor(reason: ConfigFailureReason, message: string) {
		super(message);
		this.name = "ConfigWriteError";
		this.reason = reason;
	}
}

// ---- the plan ----

/** sha256 over the canonical JSON of the plan: the four fields, keys in a fixed order. */
export function planDigest(plan: ConfigPlan): string {
	return createHash("sha256").update(canonical(plan)).digest("hex");
}

/** JSON with object keys sorted, so the same plan always hashes the same and no other plan collides. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/**
 * The last plan this process previewed for each digest.
 *
 * The digest alone cannot tell "the same request, and the file changed underneath" apart from "a
 * different request": both change the recomputed plan. Keeping what the preview saw is what makes the
 * two refusals distinct, and dropping an entry after a successful write is what makes a plan single-use.
 */
const previews = new Map<string, ConfigPreviewResult>();

/** How many unused plans are remembered; an editor shows one at a time, so this is never reached. */
const REMEMBERED_PLANS = 64;

function remember(digest: string, preview: ConfigPreviewResult): void {
	previews.set(digest, preview);
	while (previews.size > REMEMBERED_PLANS) {
		const oldest = previews.keys().next();
		if (oldest.done === true) return;
		previews.delete(oldest.value);
	}
}

/** Compute the plan a request describes. Reads the target; never writes it. */
async function planFor(request: ConfigWriteRequest): Promise<ConfigPreviewResult> {
	const current = readConfigFile(request.path);
	const change = await request.change(current);
	const after = serialize(change.next, current.text);
	const plan: ConfigPlan = { operation: request.operation, target: request.path, before: current.text, after };
	return { plan, digest: planDigest(plan), summary: change.summary, next: change.next };
}

// ---- reading ----

/**
 * The file as it is, or a `file-invalid` refusal.
 *
 * An absent file is not a failure: a family may create it, and the plan says `before: null`. A file
 * that exists but cannot be read, or does not hold a JSON object, is never written over: the state a
 * panel shows for it is `unavailable`, with this message as the reason.
 */
export function readConfigFile(path: string): ConfigFileState {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: null, value: null };
		throw new ConfigWriteError("file-invalid", `${path} could not be read (${messageOf(error)}), so nothing was written.`);
	}
	return { text, value: parseObject(path, text) };
}

function parseObject(path: string, text: string): JsonObject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(text));
	} catch (error) {
		throw new ConfigWriteError("file-invalid", invalidMessage(path, messageOf(error)));
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ConfigWriteError("file-invalid", invalidMessage(path, "the file is not a JSON object"));
	}
	return parsed as JsonObject;
}

function invalidMessage(path: string, why: string): string {
	return `${path} is not a configuration file this can edit, so it was left alone: ${why}. Fix or remove it, then preview again.`;
}

// ---- preview and apply ----

/** The plan and its digest, computed without touching the target. */
export async function configPreview(request: ConfigWriteRequest): Promise<ConfigPreviewResult> {
	const preview = await planFor(request);
	remember(preview.digest, preview);
	return preview;
}

/**
 * Perform exactly the plan the confirmation showed.
 *
 * `digest` arrives from the wire as an unchecked value, so it is required and compared as a string: a
 * missing digest is a caller mistake (an error), while a digest that does not describe this request, or
 * one that was already used, is a refusal the panel renders (`stale-plan`).
 */
export async function configApply(request: ConfigWriteRequest, digest: unknown, options: ConfigWriteOptions): Promise<ConfigApplyResult> {
	if (typeof digest !== "string" || digest.trim().length === 0) {
		throw new Error("an apply needs the digest of the plan the preview showed; preview again.");
	}

	// The file is read and parsed first: a target this cannot read is `file-invalid` whatever digest came
	// with the request, because a plan cannot even be described for it (C2).
	const current = readConfigFile(request.path).text;

	const confirmed = previews.get(digest);
	if (confirmed === undefined) {
		throw new ConfigWriteError(
			"stale-plan",
			`${request.path} was not written: this digest matches no plan this bridge has outstanding, or the plan was already applied. Preview again.`,
		);
	}
	if (current !== confirmed.plan.before) {
		throw new ConfigWriteError(
			"changed-on-disk",
			`${request.path} changed after the plan was previewed, so nothing was written. Preview again.`,
		);
	}

	// Recomputed from the same request, so a client cannot confirm one plan and send another.
	const recomputed = await planFor(request);
	if (recomputed.digest !== digest) {
		throw new ConfigWriteError(
			"stale-plan",
			`the request no longer produces the plan that was confirmed, so ${request.path} was not written. Preview again.`,
		);
	}
	if (recomputed.plan.after === recomputed.plan.before) {
		// The plan describes no change at all: nothing to write, nothing to back up, and the digest spent.
		previews.delete(digest);
		return { ...recomputed, backup: null };
	}

	let backup: string | null = null;
	const write = (): void => {
		// Inside the file's own lock the disk can still have moved since the plan was computed, so the
		// bytes are read once more: the check and the write are one decision.
		const onDisk = readConfigFile(request.path).text;
		if (onDisk !== recomputed.plan.before) {
			throw new ConfigWriteError(
				"changed-on-disk",
				`${request.path} changed after the plan was previewed, so nothing was written. Preview again.`,
			);
		}
		backup = keepBackup(request, options);
		writeAtomically(request.path, recomputed.plan.after);
		lastWritten.set(request.path, recomputed.plan.after);
	};
	if (request.lock === undefined) write();
	else request.lock(write);

	previews.delete(digest);
	return { ...recomputed, backup };
}

// ---- writing ----

/** The text this run last wrote to each file; content equal to it needs no backup. */
const lastWritten = new Map<string, string>();

/** Keep the bytes about to be replaced, unless they are exactly what this run wrote itself. */
function keepBackup(request: ConfigWriteRequest, options: ConfigWriteOptions): string | null {
	if (!existsSync(request.path)) return null;
	const current = readFileSync(request.path);
	if (lastWritten.get(request.path) === current.toString("utf8")) return null;

	const directory = join(options.configHome, `${request.family}-backups`);
	mkdirSync(directory, { recursive: true });
	const extension = extname(request.path);
	const stem = basename(request.path, extension);
	const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
	// Two backups in the same millisecond must not overwrite each other, or fail.
	for (let attempt = 0; ; attempt++) {
		const target = join(directory, `${stem}.${stamp}${attempt === 0 ? "" : `-${attempt}`}${extension}`);
		try {
			copyFileSync(request.path, target, constants.COPYFILE_EXCL);
			return target;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 50) throw error;
		}
	}
}

/**
 * Write `text` as one step: a temp file beside the target, then a rename over it.
 *
 * A half-written settings file is a settings file Pi cannot read, so nothing but a complete file ever
 * appears at the target's path. The temp file is private from the start, and so is the result.
 */
function writeAtomically(path: string, text: string): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });
	const temporary = join(directory, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
		// The umask may have narrowed the mode; the file this replaces is the user's own config.
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// The rename consumed it, or it was never created: either way there is nothing to clean up.
		}
		throw error;
	}
}

// ---- the file's own shape ----

/** Serialize with the indentation already on disk and the final newline it already had. */
function serialize(value: JsonObject, previous: string | null): string {
	const indent = indentOf(previous);
	const newline = previous === null || previous.endsWith("\n");
	return JSON.stringify(value, null, indent) + (newline ? "\n" : "");
}

/** The first indented key of a JSON object says which indentation the file was written with. */
function indentOf(text: string | null): string {
	if (text === null) return "  ";
	const match = /\n([ \t]+)"/.exec(text);
	return match?.[1] ?? "  ";
}

/** A settings file written by a Windows editor may start with a byte-order mark the parser rejects. */
function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
