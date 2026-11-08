import assert from "node:assert/strict";
import test from "node:test";
import { extensionErrorText, startsRun } from "./prompt-outcome.ts";

test("a handled prompt never starts a run, so nothing will settle it", () => {
	// Pi answers an extension command with "handled" and emits no agent_start or agent_settled.
	assert.equal(startsRun({ disposition: "handled" }), false);
});

test("a prompt that starts or queues a run is still working", () => {
	assert.equal(startsRun({ disposition: "started" }), true);
	assert.equal(startsRun({ disposition: "queued" }), true);
});

test("an answer without a disposition keeps the run, as an older Pi would report it", () => {
	assert.equal(startsRun(undefined), true);
	assert.equal(startsRun(null), true);
	assert.equal(startsRun({}), true);
	assert.equal(startsRun("ok"), true);
});

test("an extension error names the command and the cause", () => {
	assert.equal(
		extensionErrorText({ type: "extension_error", extensionPath: "/x/gentle-ai.ts", event: "command:gentle:profiles", error: "boom" }),
		"gentle:profiles failed: boom",
	);
});

test("an extension error without an event still reports the cause", () => {
	assert.equal(extensionErrorText({ type: "extension_error", error: "boom" }), "an extension failed: boom");
	assert.equal(extensionErrorText({ type: "extension_error" }), "an extension failed: unknown error");
});
