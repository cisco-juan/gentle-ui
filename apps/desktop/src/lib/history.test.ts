import assert from "node:assert/strict";
import test from "node:test";
import { OLDER_PAGE_PX, shouldLoadOlder } from "./history.ts";

const idle = { loading: false, hasOlder: true };

test("a reader at the top asks for the next older page", () => {
	assert.equal(shouldLoadOlder({ ...idle, scrollTop: 0 }), true);
	assert.equal(shouldLoadOlder({ ...idle, scrollTop: 120 }), true);
});

test("a reader near the top counts as at the top", () => {
	assert.equal(shouldLoadOlder({ ...idle, scrollTop: OLDER_PAGE_PX }), true);
	assert.equal(shouldLoadOlder({ ...idle, scrollTop: OLDER_PAGE_PX + 1 }), false);
});

test("a reader in the middle of the transcript is left alone", () => {
	assert.equal(shouldLoadOlder({ ...idle, scrollTop: 640 }), false);
});

test("no page is asked for while one is already in flight", () => {
	assert.equal(shouldLoadOlder({ ...idle, loading: true, scrollTop: 0 }), false);
});

test("no page is asked for when the file has nothing older", () => {
	assert.equal(shouldLoadOlder({ ...idle, hasOlder: false, scrollTop: 0 }), false);
});
