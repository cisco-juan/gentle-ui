import assert from "node:assert/strict";
import test from "node:test";
import { cycle } from "./menu.ts";

test("arrows walk the list and wrap at both ends", () => {
	assert.equal(cycle(0, 1, 3), 1);
	assert.equal(cycle(2, 1, 3), 0);
	assert.equal(cycle(0, -1, 3), 2);
	assert.equal(cycle(1, -1, 3), 0);
});

test("with nothing chosen yet, down picks the first row and up the last", () => {
	assert.equal(cycle(-1, 1, 4), 0);
	assert.equal(cycle(-1, -1, 4), 3);
});

test("an empty list has nothing to choose", () => {
	assert.equal(cycle(-1, 1, 0), -1);
	assert.equal(cycle(2, -1, 0), -1);
});

test("a position past a list that shrank counts as nothing chosen", () => {
	// Typing narrows the suggestions; a stale index must not point past the end.
	assert.equal(cycle(7, 1, 3), 0);
	assert.equal(cycle(7, -1, 3), 2);
});
