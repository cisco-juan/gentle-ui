import assert from "node:assert/strict";
import test from "node:test";
import { streamIntent } from "./stream.ts";

test("a text delta is text and a thinking delta is thinking", () => {
	assert.deepEqual(streamIntent({ type: "text_delta", delta: "hola" }), { kind: "text", delta: "hola" });
	assert.deepEqual(streamIntent({ type: "thinking_delta", delta: "pensando" }), { kind: "thinking", delta: "pensando" });
});

test("every other stream event is ignored instead of being guessed as text", () => {
	for (const type of [
		"text_start",
		"text_end",
		"thinking_start",
		"thinking_end",
		"toolcall_start",
		"toolcall_delta",
		"toolcall_end",
		"error",
	]) {
		assert.deepEqual(streamIntent({ type }), { kind: "ignore" }, `type ${type}`);
	}
});

test("a delta with no text is ignored, so an empty bubble never appears", () => {
	assert.deepEqual(streamIntent({ type: "text_delta" }), { kind: "ignore" });
	assert.deepEqual(streamIntent({ type: "text_delta", delta: "" }), { kind: "ignore" });
	assert.deepEqual(streamIntent({ type: "thinking_delta" }), { kind: "ignore" });
});
