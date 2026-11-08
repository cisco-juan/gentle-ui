/**
 * Composer attachments.
 *
 * Pure helpers the composer, the chat controller and the tests all share. Nothing here imports Solid,
 * the DOM or Node, so the same functions run in the webview and under `node --test`; `sanitizeName` is
 * mirrored byte for byte in the bridge (`packages/bridge/src/uploads.ts`) and a bridge test proves the
 * two copies still answer the same way.
 */

export type AttachmentKind = "image" | "file";

/** `uploading` is the moment between a drop and the bridge answering with a path. */
export type AttachmentStatus = "uploading" | "ready" | "failed";

/** The part of the browser `File` the composer needs, so a test can stand in for a drop. */
export interface FileLike {
	readonly name: string;
	readonly type: string;
	readonly size: number;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export interface Attachment {
	readonly id: string;
	readonly name: string;
	readonly size: number;
	readonly mimeType: string;
	readonly kind: AttachmentKind;
	/** Base64 without the data-URL prefix. Images keep it until the prompt is sent. */
	readonly dataBase64?: string;
	/** Absolute path under the agent's uploads directory, set once the bridge accepted the file. */
	readonly path?: string;
	readonly status: AttachmentStatus;
}

/** One image, in the shape Pi's `prompt` command takes. */
export interface PromptImage {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

/** The one error `sanitizeName` throws; the bridge answers with the same text. */
export const INVALID_NAME_ERROR = "file name is not allowed";

/**
 * Message text that names an image-only prompt. Pi's `prompt` takes a required string, so a message
 * made of images alone still needs a line to carry it.
 */
export const IMAGE_ONLY_PROMPT = "[attached image]";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
};

/** Images travel to the agent as images; everything else is uploaded and travels as a path. */
export function classifyFile(name: string, mimeType: string): AttachmentKind {
	if (mimeType.trim().toLowerCase().startsWith("image/")) return "image";
	return IMAGE_EXTENSIONS.has(extensionOf(name)) ? "image" : "file";
}

/** Read a dropped or pasted file as base64, without the data-URL prefix Pi does not want. */
export async function readAsBase64(file: FileLike): Promise<string> {
	return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

/** Base64 encoder for browsers: `btoa` needs a binary string per chunk, which is easy to get wrong. */
function bytesToBase64(bytes: Uint8Array): string {
	let encoded = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1] ?? 0;
		const third = bytes[index + 2] ?? 0;
		encoded += BASE64_ALPHABET[first >> 2];
		encoded += BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
		encoded += index + 1 < bytes.length ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : "=";
		encoded += index + 2 < bytes.length ? BASE64_ALPHABET[third & 0x3f] : "=";
	}
	return encoded;
}

/**
 * The name the bridge will write to disk.
 *
 * Mirrors `sanitizeName` in the bridge: separators and `..` are refused before anything is replaced, so
 * a name can never leave the uploads directory, and an empty result is refused too.
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

/** Turn a drop into the attachment the strip renders: images keep their bytes, files wait for a path. */
export function describeAttachment(id: string, file: FileLike, dataBase64: string): Attachment {
	const kind = classifyFile(file.name, file.type);
	return {
		id,
		name: file.name,
		size: file.size,
		mimeType: file.type,
		kind,
		status: kind === "image" ? "ready" : "uploading",
		...(kind === "image" ? { dataBase64 } : {}),
	};
}

/** Uploaded absolute paths, in the order the files arrived. */
export function uploadedPaths(entries: readonly Attachment[]): string[] {
	const paths: string[] = [];
	for (const entry of entries) {
		if (entry.path !== undefined && entry.path.trim().length > 0) paths.push(entry.path);
	}
	return paths;
}

/**
 * The message text: what the user typed, then one `attached: <path>` line per uploaded file.
 *
 * Stable and readable, so the agent reads the same block a human does, and an attachment-only message
 * still carries something.
 */
export function composePrompt(text: string, paths: readonly string[]): string {
	const body = text.trim();
	const unique = [...new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0))];
	if (unique.length === 0) return body;

	const block = unique.map((path) => `attached: ${path}`).join("\n");
	return body.length === 0 ? block : `${body}\n\n${block}`;
}

/** The `images` array Pi's `prompt` command takes, with bare base64 and a real mime type. */
export function buildImages(entries: readonly Attachment[]): PromptImage[] {
	const images: PromptImage[] = [];
	for (const entry of entries) {
		if (entry.kind !== "image" || entry.dataBase64 === undefined) continue;
		const data = stripDataUrl(entry.dataBase64);
		if (data.length === 0) continue;
		images.push({ type: "image", data, mimeType: imageMimeType(entry) });
	}
	return images;
}

/** Pi wants raw base64; a clipboard image sometimes arrives as a `data:` URL. */
export function stripDataUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed.startsWith("data:")) return trimmed;
	const comma = trimmed.indexOf(",");
	return comma === -1 ? "" : trimmed.slice(comma + 1);
}

/** Sizes in the strip: `900 B`, `1.5 kB`, `25 MB`. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	if (bytes < 1024) return `${Math.round(bytes)} B`;

	const units = ["kB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function imageMimeType(entry: Attachment): string {
	const declared = entry.mimeType.trim().toLowerCase();
	if (declared.startsWith("image/")) return declared;
	return MIME_BY_EXTENSION[extensionOf(entry.name)] ?? "image/png";
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}
