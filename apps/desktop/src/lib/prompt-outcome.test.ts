import assert from "node:assert/strict";
import test from "node:test";
import { extensionErrorText, promptParams, startsRun, wasCancelled } from "./prompt-outcome.ts";

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

test("a prompt sent while the agent works is queued behind the run, not refused", () => {
	// Without streamingBehavior Pi rejects it: "Agent is already processing".
	assert.deepEqual(promptParams("and this too", [], true), { message: "and this too", streamingBehavior: "followUp" });
});

test("an idle prompt carries no streaming behavior", () => {
	assert.deepEqual(promptParams("hello", [], false), { message: "hello" });
});

test("images travel with the prompt in both states", () => {
	const images = [{ type: "image" as const, data: "AA==", mimeType: "image/png" }];
	assert.deepEqual(promptParams("look", images, false), { message: "look", images });
	assert.deepEqual(promptParams("look", images, true), { message: "look", images, streamingBehavior: "followUp" });
});

test("a session change an extension vetoed is reported as cancelled", () => {
	assert.equal(wasCancelled({ cancelled: true }), true);
	assert.equal(wasCancelled({ cancelled: false }), false);
	assert.equal(wasCancelled(undefined), false);
	assert.equal(wasCancelled("ok"), false);
});
