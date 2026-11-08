import assert from "node:assert/strict";
import test from "node:test";
import { isSettable, parsePermissionStatus, permissionRows, terminalCommands } from "./permissions.ts";

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

test("the mode menu lists every mode, and only normal and auto are writable before the bridge answers", () => {
	const rows = permissionRows(null);
	assert.deepEqual(rows.map((row) => row.mode), ["normal", "auto", "yolo", "super-yolo"]);
	assert.deepEqual(rows.map((row) => row.settable), [true, true, false, false]);
	assert.deepEqual(rows.map((row) => row.current), [false, false, false, false]);
	assert.deepEqual(rows.map((row) => row.terminal), [null, null, "/gentle:mode default yolo", "/gentle:mode default super-yolo"]);
});

test("the current row is the default the bridge reported, not the one the UI hoped for", () => {
	const rows = permissionRows({
		state: "ok",
		reason: null,
		message: "",
		default: "auto",
		stored: true,
		settable: ["normal", "auto"],
	});
	assert.deepEqual(rows.filter((row) => row.current).map((row) => row.mode), ["auto"]);
});

test("the bridge's own list of writable modes wins over the local fallback", () => {
	const rows = permissionRows({
		state: "ok",
		reason: null,
		message: "",
		default: "normal",
		stored: false,
		settable: ["normal"],
	});
	assert.equal(rows.find((row) => row.mode === "auto")?.settable, false);
	assert.equal(rows.find((row) => row.mode === "auto")?.terminal, "/gentle:mode default auto");
});

test("an unreadable preference file offers no writable mode and says why", () => {
	const rows = permissionRows({
		state: "unavailable",
		reason: "file-invalid",
		message: "the file could not be read",
		default: null,
		stored: false,
		settable: [],
	});
	assert.deepEqual(rows.map((row) => row.settable), [false, false, false, false]);
	assert.deepEqual(rows.map((row) => row.current), [false, false, false, false]);
});
