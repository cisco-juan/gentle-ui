import assert from "node:assert/strict";
import test from "node:test";
import { checkCommand, describeCommand, isRunnableCommand, shellAction, unknownCommandNotice } from "./commands.ts";

test("a terminal overlay is recognised and named", () => {
	const verdict = checkCommand("/gentle:agents");
	assert.equal(verdict.runnable, false);
	assert.equal(verdict.description.kind, "terminal");
	assert.equal(verdict.description.surface, "the Agents tab");
});

test("commands that only need the agent are forwarded", () => {
	// These were wrongly blocked at first: they notify or write config, no overlay involved.
	for (const name of ["gentle:doctor", "gentle:status", "gentle:banner", "gentle:vim", "gentle:animations", "gentle:design"]) {
		assert.equal(isRunnableCommand(name), true, `${name} must be forwarded`);
	}
	assert.equal(isRunnableCommand("skill:go-testing"), true);
	assert.equal(isRunnableCommand("skill-registry:refresh"), true);
});

test("the first argument can make a terminal command safe", () => {
	// Bare gentle:profiles opens the fullscreen picker and even throws; the file verbs never reach it.
	assert.equal(isRunnableCommand("gentle:profiles"), false);
	assert.equal(checkCommand("/gentle:profiles export").runnable, true);
	assert.equal(checkCommand("/gentle:profiles import backup.json").runnable, true);
	assert.equal(checkCommand("/gentle:profiles publish").runnable, true);
	assert.equal(checkCommand("/gentle:mode status").runnable, true);
	assert.equal(checkCommand("/gentle:mode yolo").runnable, false);
	assert.equal(checkCommand("/gentle:yolo status").runnable, true);
});

test("history is classified without the gentle prefix", () => {
	assert.equal(checkCommand("/history").runnable, false);
	assert.equal(describeCommand("history").kind, "terminal");
	assert.equal(isRunnableCommand("gentle:history"), true, "no such command exists, so it is forwarded");
});

test("an unknown command is treated as agent work", () => {
	// Refusing a real command is worse than forwarding one: the agent reports its own errors.
	assert.deepEqual(describeCommand("skill:go-testing"), { name: "skill:go-testing", kind: "agent" });
});

test("every terminal entry explains itself", () => {
	for (const name of ["gentle:agents", "gentle:panel", "gentle:jobs", "gentle:usage", "gentle:music", "gentle:voice", "gentle:stats", "gentle:guide"]) {
		const described = describeCommand(name);
		assert.equal(described.kind, "terminal", `${name} must be terminal`);
		assert.ok((described.note ?? "").length > 0, `${name} needs a note`);
	}
});

const KNOWN = ["gentle:profiles", "gentle:doctor", "gentle:status", "skill:go-testing"];

test("a mistyped command names the one it was probably meant to be", () => {
	assert.equal(
		unknownCommandNotice("/gentle:profile", KNOWN),
		"/gentle:profile is not a command here. Did you mean /gentle:profiles?",
	);
	assert.equal(
		unknownCommandNotice("/gentle:docter", KNOWN),
		"/gentle:docter is not a command here. Did you mean /gentle:doctor?",
	);
});

test("a known command, with or without arguments, is never flagged", () => {
	assert.equal(unknownCommandNotice("/gentle:profiles export", KNOWN), null);
	assert.equal(unknownCommandNotice("/GENTLE:DOCTOR", KNOWN), null);
});

test("a command the shell already classifies is not flagged", () => {
	// Terminal-only commands have their own warning, and Pi may not list them.
	assert.equal(unknownCommandNotice("/history", KNOWN), null);
});

test("text that only starts with a slash is forwarded, not corrected", () => {
	assert.equal(unknownCommandNotice("/home/cisco/notes.txt please read it", KNOWN), null);
	assert.equal(unknownCommandNotice("/zzzzzz", KNOWN), null);
	assert.equal(unknownCommandNotice("/ng", KNOWN), null, "too short to be a typo of anything");
});

test("nothing is flagged before the agent has listed its commands", () => {
	assert.equal(unknownCommandNotice("/gentle:profile", []), null);
});

test("bare /gentle:profiles is answered by the shell's own sheet, never sent to the agent", () => {
	assert.equal(shellAction("/gentle:profiles"), "profiles");
	assert.equal(shellAction("  /gentle:profiles  "), "profiles");
	assert.equal(shellAction("/GENTLE:PROFILES"), "profiles");
});

test("the profile verbs are not the sheet: they keep going to the agent", () => {
	assert.equal(shellAction("/gentle:profiles export alpha"), null);
	assert.equal(shellAction("/gentle:profiles clear"), null);
	assert.equal(checkCommand("/gentle:profiles export alpha").runnable, true);
});

test("other lines are not shell actions", () => {
	assert.equal(shellAction("/gentle:profile"), null);
	assert.equal(shellAction("/gentle:doctor"), null);
	assert.equal(shellAction("hello /gentle:profiles"), null);
});
