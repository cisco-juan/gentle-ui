import assert from "node:assert/strict";
import test from "node:test";
import { activityOf } from "./activity.ts";

test("a live tool names itself instead of leaving the reader with a generic spinner", () => {
	assert.equal(
		activityOf({ running: true, draft: "", lastKind: "tool", lastName: "bash", lastStatus: "running" }),
		"running bash",
	);
	assert.equal(activityOf({ running: true, draft: "", lastKind: "tool", lastStatus: "running" }), "running a tool");
});

test("thinking and writing are told apart, because they fail differently", () => {
	assert.equal(activityOf({ running: true, draft: "", lastKind: "thinking", lastStatus: "running" }), "thinking");
	assert.equal(activityOf({ running: true, draft: "hola", lastKind: "thinking", lastStatus: "done" }), "writing the answer");
});

test("a finished tool, an open question and a bare run each still say something is happening", () => {
	assert.equal(activityOf({ running: true, draft: "", lastKind: "tool", lastName: "bash", lastStatus: "done" }), "working");
	assert.equal(activityOf({ running: true, draft: "", lastKind: "permission", lastStatus: "running" }), "waiting for your approval");
	assert.equal(activityOf({ running: true, draft: "", lastKind: null }), "working");
});

test("nothing is claimed once the run ends, whatever the transcript holds", () => {
	assert.equal(activityOf({ running: false, draft: "hola", lastKind: "thinking", lastStatus: "running" }), null);
	assert.equal(activityOf({ running: false, draft: "", lastKind: null }), null);
});
