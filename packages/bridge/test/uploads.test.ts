import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	INVALID_DATA_ERROR,
	INVALID_NAME_ERROR,
	MAX_UPLOAD_BYTES,
	TOO_LARGE_ERROR,
	sanitizeName,
	saveUpload,
} from "../src/uploads.ts";
// The composer mirrors `sanitizeName` so the client can pre-flight a drop without a round trip. Loading
// that copy here is the only way to prove both sides still answer the same way for the same input.
import { sanitizeName as clientSanitizeName } from "../../../apps/desktop/src/lib/attachments.ts";

const MIB = 1024 * 1024;
const NOW = 1_700_000_000_000;

/** A throwaway agent home that removes itself when the test ends. */
function scratch(t: TestContext): string {
	const home = mkdtempSync(join(tmpdir(), "gentle-uploads-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return home;
}

/** Every name the uploads directory holds, or an empty list when it was never created. */
function uploadedNames(home: string): string[] {
	try {
		return readdirSync(join(home, "uploads")).sort();
	} catch {
		return [];
	}
}

function attempt(sanitize: (name: string) => string, name: string): unknown {
	try {
		return { value: sanitize(name) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

test("writes the decoded bytes to an absolute path inside the agent home", async (t) => {
	const home = scratch(t);
	// Binary, not text: a byte-for-byte comparison has to cover 0x00 and a high byte.
	const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a]);

	const saved = await saveUpload(home, "shot.png", bytes.toString("base64"), NOW);

	assert.equal(saved.bytes, bytes.length);
	assert.equal(saved.path, join(home, "uploads", `${NOW}-shot.png`));
	assert.deepEqual(readFileSync(saved.path), bytes);
});

test("creates the uploads directory when the agent home has none", async (t) => {
	const home = scratch(t);
	assert.deepEqual(uploadedNames(home), []);

	await saveUpload(home, "notes.txt", Buffer.from("hi").toString("base64"), NOW);
	// A second upload reuses the directory the first one created.
	await saveUpload(home, "second.txt", Buffer.from("again").toString("base64"), NOW + 1);

	assert.deepEqual(uploadedNames(home), [`${NOW}-notes.txt`, `${NOW + 1}-second.txt`]);
	assert.equal(readFileSync(join(home, "uploads", `${NOW}-notes.txt`), "utf8"), "hi");
});

test("sanitizes a hostile name and keeps the extension", async (t) => {
	const home = scratch(t);

	const saved = await saveUpload(home, "my report (final)!.png", Buffer.from("x").toString("base64"), NOW);

	assert.equal(saved.path, join(home, "uploads", `${NOW}-my-report-final-.png`));
	assert.deepEqual(uploadedNames(home), [`${NOW}-my-report-final-.png`]);
});

test("rejects traversal and separators before writing anything", async (t) => {
	const home = scratch(t);
	const data = Buffer.from("evil").toString("base64");

	for (const name of ["../evil", "..", "dir/evil", "dir\\evil", "a..b.txt"]) {
		await assert.rejects(saveUpload(home, name, data, NOW), { message: INVALID_NAME_ERROR }, name);
	}

	assert.deepEqual(uploadedNames(home), []);
});

test("rejects a name that sanitizes to nothing", async (t) => {
	const home = scratch(t);

	await assert.rejects(saveUpload(home, "!!!", Buffer.from("x").toString("base64"), NOW), {
		message: INVALID_NAME_ERROR,
	});
	await assert.rejects(saveUpload(home, "", Buffer.from("x").toString("base64"), NOW), {
		message: INVALID_NAME_ERROR,
	});

	assert.deepEqual(uploadedNames(home), []);
});

test("refuses an upload over the cap without leaving a partial file", async (t) => {
	const home = scratch(t);
	// One byte past the cap is enough: the size is checked before anything touches the disk.
	const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString("base64");

	await assert.rejects(saveUpload(home, "huge.bin", oversized, NOW), { message: TOO_LARGE_ERROR });
	assert.deepEqual(uploadedNames(home), []);
});

test("accepts an upload of exactly the cap", async (t) => {
	const home = scratch(t);
	const exact = Buffer.alloc(MAX_UPLOAD_BYTES, 7).toString("base64");

	const saved = await saveUpload(home, "exact.bin", exact, NOW);

	assert.equal(saved.bytes, MAX_UPLOAD_BYTES);
	assert.equal(uploadedNames(home).length, 1);
});

test("rejects a payload that is not base64", async (t) => {
	const home = scratch(t);

	await assert.rejects(saveUpload(home, "notes.txt", "not base64!!", NOW), { message: INVALID_DATA_ERROR });
	assert.deepEqual(uploadedNames(home), []);
});

test("the composer's sanitiser agrees with the bridge's", () => {
	const cases = [
		"shot.png",
		"my report (final)!.png",
		"screenshot (2).png",
		"a--b.txt",
		"ñandú.png",
		"UPPER_case-1.md",
		"..",
		"../evil",
		"dir/evil",
		"dir\\evil",
		"a..b.txt",
		"!!!",
		"",
	];

	for (const name of cases) {
		assert.deepEqual(attempt(clientSanitizeName, name), attempt(sanitizeName, name), `disagreement for ${JSON.stringify(name)}`);
	}
});
