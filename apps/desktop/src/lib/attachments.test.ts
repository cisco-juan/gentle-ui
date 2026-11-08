// This package has no `@types/node`: the runner is Node's own. The directives keep `tsc --noEmit` honest
// about every other line; drop them once `@types/node` is a devDependency here.
// @ts-expect-error -- node built-in types are not installed for this package
import assert from "node:assert/strict";
// @ts-expect-error -- node built-in types are not installed for this package
import test from "node:test";
import {
	buildImages,
	classifyFile,
	composePrompt,
	formatBytes,
	readAsBase64,
	sanitizeName,
	stripDataUrl,
	type Attachment,
	type FileLike,
} from "./attachments.ts";

/** The part of the browser `File` these helpers act on, so a test can stand in for a drop. */
function fileOf(name: string, type: string, bytes: readonly number[]): FileLike {
	const data = new Uint8Array(bytes);
	return {
		name,
		type,
		size: data.byteLength,
		arrayBuffer: async () => new Uint8Array(data).buffer,
	};
}

function attachment(change: Partial<Attachment> & Pick<Attachment, "name" | "kind">): Attachment {
	return {
		id: change.id ?? change.name,
		size: change.size ?? 1024,
		mimeType: change.mimeType ?? "",
		status: change.status ?? "ready",
		...change,
	};
}

test("classifyFile trusts an image mime type", () => {
	assert.equal(classifyFile("shot", "image/png"), "image");
	assert.equal(classifyFile("clipboard", "image/jpeg"), "image");
});

test("classifyFile falls back to the extension when the mime type is missing", () => {
	assert.equal(classifyFile("shot.png", ""), "image");
	assert.equal(classifyFile("photo.JPG", "application/octet-stream"), "image");
	assert.equal(classifyFile("motion.webp", ""), "image");
});

test("classifyFile treats everything else as a file", () => {
	assert.equal(classifyFile("notes.md", "text/markdown"), "file");
	assert.equal(classifyFile("bundle.zip", "application/zip"), "file");
	assert.equal(classifyFile("no-extension", ""), "file");
});

test("readAsBase64 encodes the exact bytes, unpadded data-URL absent", async () => {
	assert.equal(await readAsBase64(fileOf("hello.txt", "text/plain", [0x68, 0x69])), "aGk=");
	// 0x00 0xff 0x10 0x89 exercises the zero byte and a high byte.
	assert.equal(await readAsBase64(fileOf("bytes.bin", "", [0x00, 0xff, 0x10, 0x89])), "AP8QiQ==");
	assert.equal(await readAsBase64(fileOf("empty", "", [])), "");
});

test("sanitizeName mirrors the bridge's rules", () => {
	assert.equal(sanitizeName("shot.png"), "shot.png");
	assert.equal(sanitizeName("my report (final)!.png"), "my-report-final-.png");
	assert.equal(sanitizeName("a--b.txt"), "a-b.txt");
	assert.equal(sanitizeName("ñandú.png"), "and-.png");
	assert.equal(sanitizeName("UPPER_case-1.md"), "UPPER_case-1.md");
});

test("sanitizeName rejects separators, traversal and empty results", () => {
	for (const name of ["../evil", "..", "dir/evil", "dir\\evil", "a..b.txt", "!!!", ""]) {
		assert.throws(() => sanitizeName(name), /file name is not allowed/, name);
	}
});

test("composePrompt leaves a plain message alone", () => {
	assert.equal(composePrompt("look at this", []), "look at this");
	assert.equal(composePrompt("  look at this  ", []), "look at this");
});

test("composePrompt appends one attached line per path", () => {
	assert.equal(
		composePrompt("look at this", ["/home/me/uploads/1-shot.png", "/home/me/uploads/2 notes.md"]),
		"look at this\n\nattached: /home/me/uploads/1-shot.png\nattached: /home/me/uploads/2 notes.md",
	);
});

test("composePrompt keeps a path attached to an empty message", () => {
	assert.equal(composePrompt("", ["/home/me/uploads/1-shot.png"]), "attached: /home/me/uploads/1-shot.png");
	assert.equal(composePrompt("   ", ["/home/me/uploads/1-shot.png"]), "attached: /home/me/uploads/1-shot.png");
});

test("composePrompt lists a repeated path once, in the order it arrived", () => {
	assert.equal(
		composePrompt("x", ["/a.png", "/b.png", "/a.png"]),
		"x\n\nattached: /a.png\nattached: /b.png",
	);
});

test("buildImages keeps images only, in the shape Pi's prompt takes", () => {
	const images = buildImages([
		attachment({ name: "shot.png", kind: "image", mimeType: "image/png", dataBase64: "AAAA" }),
		attachment({ name: "notes.md", kind: "file", mimeType: "text/markdown", path: "/tmp/notes.md" }),
		attachment({ name: "photo", kind: "image", mimeType: "", dataBase64: "BBBB" }),
	]);

	assert.deepEqual(images, [
		{ type: "image", data: "AAAA", mimeType: "image/png" },
		// No mime type on the entry: the extension is not on the name either, so PNG is the fallback.
		{ type: "image", data: "BBBB", mimeType: "image/png" },
	]);
});

test("buildImages strips a data-URL prefix and skips an image with no payload", () => {
	const images = buildImages([
		attachment({ name: "paste.png", kind: "image", mimeType: "image/png", dataBase64: "data:image/png;base64,CCCC" }),
		attachment({ name: "broken.png", kind: "image", mimeType: "image/png" }),
	]);

	assert.deepEqual(images, [{ type: "image", data: "CCCC", mimeType: "image/png" }]);
});

test("stripDataUrl leaves plain base64 alone", () => {
	assert.equal(stripDataUrl("data:image/png;base64,CCCC"), "CCCC");
	assert.equal(stripDataUrl("CCCC"), "CCCC");
});

test("formatBytes reads like a file manager", () => {
	assert.equal(formatBytes(0), "0 B");
	assert.equal(formatBytes(900), "900 B");
	assert.equal(formatBytes(1023), "1023 B");
	assert.equal(formatBytes(1536), "1.5 kB");
	assert.equal(formatBytes(25 * 1024 * 1024), "25 MB");
});
