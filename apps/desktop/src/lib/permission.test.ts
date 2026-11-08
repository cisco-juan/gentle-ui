import assert from "node:assert/strict";
import test from "node:test";
import { answerLabel, isSubmitKey } from "./permission.ts";

test("an answered card says what was decided, not a bare boolean", () => {
	assert.equal(answerLabel({ confirmed: true }), "approved");
	assert.equal(answerLabel({ confirmed: false }), "rejected");
	assert.equal(answerLabel({ value: "yes please" }), "yes please");
	assert.equal(answerLabel({ cancelled: true }), "cancelled");
	assert.equal(answerLabel({}), "");
});

test("Enter sends a one-line input", () => {
	assert.equal(isSubmitKey("input", { key: "Enter", isComposing: false, ctrlKey: false, metaKey: false }), true);
	assert.equal(isSubmitKey("input", { key: "a", isComposing: false, ctrlKey: false, metaKey: false }), false);
});

test("Enter that confirms an input method composition is not a send", () => {
	// Choosing a candidate in a Japanese or Chinese IME ends with Enter; sending then would cut the text.
	assert.equal(isSubmitKey("input", { key: "Enter", isComposing: true, ctrlKey: false, metaKey: false }), false);
});

test("a multi-line editor keeps Enter for the newline and sends on Ctrl or Cmd+Enter", () => {
	assert.equal(isSubmitKey("editor", { key: "Enter", isComposing: false, ctrlKey: false, metaKey: false }), false);
	assert.equal(isSubmitKey("editor", { key: "Enter", isComposing: false, ctrlKey: true, metaKey: false }), true);
	assert.equal(isSubmitKey("editor", { key: "Enter", isComposing: false, ctrlKey: false, metaKey: true }), true);
});

test("other dialogs have no send key", () => {
	assert.equal(isSubmitKey("select", { key: "Enter", isComposing: false, ctrlKey: false, metaKey: false }), false);
});
