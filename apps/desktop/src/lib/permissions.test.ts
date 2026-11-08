import assert from "node:assert/strict";
import test from "node:test";
import { isSettable, parsePermissionStatus, terminalCommands } from "./permissions.ts";

test("the real mode is read from the status Pi publishes", () => {
	assert.equal(parsePermissionStatus("Permissions: NORMAL"), "normal");
	assert.equal(parsePermissionStatus("Permissions: AUTO"), "auto");
	assert.equal(parsePermissionStatus("Permissions: YOLO"), "yolo");
	assert.equal(parsePermissionStatus("Permissions: SUPER-YOLO"), "super-yolo");
});

test("a status that is not a permission mode reads as unknown, never as a guess", () => {
	assert.equal(parsePermissionStatus(undefined), null);
	assert.equal(parsePermissionStatus(""), null);
	assert.equal(parsePermissionStatus("Permissions: ROOT"), null);
	assert.equal(parsePermissionStatus("🚀 YOLO ON 🔥 — destructive confirmations remain"), null);
});

test("only lowering is settable from the UI: normal and auto, never yolo or super-yolo", () => {
	assert.equal(isSettable("normal"), true);
	assert.equal(isSettable("auto"), true);
	assert.equal(isSettable("yolo"), false);
	assert.equal(isSettable("super-yolo"), false);
	assert.equal(isSettable("root"), false);
});

test("an elevated mode comes with the terminal commands that set it, for this thread and for new ones", () => {
	assert.deepEqual(terminalCommands("yolo"), { thread: "/gentle:mode yolo", newThreads: "/gentle:mode default yolo" });
	assert.deepEqual(terminalCommands("super-yolo"), { thread: "/gentle:mode super-yolo", newThreads: "/gentle:mode default super-yolo" });
});
