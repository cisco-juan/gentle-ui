import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { UploadedFile } from "@gentle-shell/protocol";

/**
 * Composer uploads.
 *
 * The desktop webview has no filesystem, so a dropped file travels to the bridge as base64 and lands in
 * the agent home, where the agent process can read it. The uploads directory is the whole boundary, the
 * same way the workspace root is for the inspector: every write is resolved first and refused when it
 * would land outside.
 */

/** Decoded cap. Checked from the encoded length, before anything is decoded or written. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The directory under the agent home that holds attachments. */
export const UPLOADS_DIRECTORY = "uploads";

/** The one error a name that cannot be written may produce; the composer mirrors this text. */
export const INVALID_NAME_ERROR = "file name is not allowed";
/** The one error an oversized upload may produce. */
export const TOO_LARGE_ERROR = "upload exceeds 25 MiB";
/** A payload that is not base64 never reaches the filesystem. */
export const INVALID_DATA_ERROR = "upload data is not valid base64";
/** A write that would land outside the uploads directory. */
export const ESCAPE_ERROR = "upload path escapes the uploads directory";

/**
 * The name the upload is written with, mirrored byte for byte in the composer.
 *
 * Separators and `..` are refused before anything is replaced, so a hostile name can never be a path;
 * the remaining characters are reduced to `[A-Za-z0-9._-]` with runs collapsed, and an empty result is
 * refused rather than becoming a nameless file.
 */
export function sanitizeName(name: string): string {
	if (name.includes("/") || name.includes("\\") || name.includes("..")) throw new Error(INVALID_NAME_ERROR);
	const sanitized = name
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	if (sanitized.length === 0) throw new Error(INVALID_NAME_ERROR);
	return sanitized;
}

/**
 * Write one upload into `<agentHome>/uploads/<timestamp>-<sanitized name>`.
 *
 * The directory is created on demand. Nothing is written unless the name is writable and the decoded
 * size fits the cap, so a rejected upload leaves no partial file behind.
 */
export async function saveUpload(
	agentHome: string,
	name: string,
	dataBase64: string,
	now = Date.now(),
): Promise<UploadedFile> {
	const safeName = sanitizeName(name);
	const bytes = decodeBase64(dataBase64);

	const directory = resolve(agentHome, UPLOADS_DIRECTORY);
	const stamp = Number.isFinite(now) ? Math.trunc(now) : Date.now();
	const target = resolve(directory, `${stamp}-${safeName}`);
	if (!inside(directory, target)) throw new Error(ESCAPE_ERROR);

	await mkdir(directory, { recursive: true });
	await writeFile(target, bytes);
	return { path: target, bytes: bytes.byteLength };
}

/** Decode after checking the charset and the cap, so a hostile payload is cheap to refuse. */
function decodeBase64(dataBase64: string): Buffer {
	if (typeof dataBase64 !== "string") throw new Error(INVALID_DATA_ERROR);

	const compact = dataBase64.replace(/\s+/g, "");
	if (compact.length === 0) return Buffer.alloc(0);
	if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw new Error(INVALID_DATA_ERROR);

	const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
	const decodedSize = (compact.length / 4) * 3 - padding;
	if (decodedSize > MAX_UPLOAD_BYTES) throw new Error(TOO_LARGE_ERROR);

	const bytes = Buffer.from(compact, "base64");
	// The arithmetic above is exact for valid base64; this keeps the cap true even if it is not.
	if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(TOO_LARGE_ERROR);
	return bytes;
}

function inside(base: string, candidate: string): boolean {
	return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : base + sep);
}
