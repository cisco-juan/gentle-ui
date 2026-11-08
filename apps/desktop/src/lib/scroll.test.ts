import assert from "node:assert/strict";
import test from "node:test";
import { isNearBottom } from "./scroll.ts";

test("a reader at the bottom keeps following the stream", () => {
	assert.equal(isNearBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 }), true);
});

test("a few pixels of slack still count as the bottom", () => {
	assert.equal(isNearBottom({ scrollTop: 560, clientHeight: 400, scrollHeight: 1000 }), true);
});

test("a reader who scrolled up to read is left where they are", () => {
	assert.equal(isNearBottom({ scrollTop: 200, clientHeight: 400, scrollHeight: 1000 }), false);
});

test("a transcript that fits its pane is at the bottom", () => {
	assert.equal(isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 }), true);
});
