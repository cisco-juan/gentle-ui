import assert from "node:assert/strict";
import test from "node:test";
import { describeCommand, isRunnableCommand } from "./commands.ts";

test("a terminal overlay is recognised and named", () => {
	const agents = describeCommand("gentle:agents");
	assert.equal(agents.kind, "terminal");
	assert.match(agents.note ?? "", /terminal view/);
	assert.equal(agents.surface, "Agents");
});

test("the lookup ignores case and a leading slash is not part of the name", () => {
	assert.equal(describeCommand("GENTLE:HISTORY").kind, "terminal");
	assert.equal(isRunnableCommand("/gentle:agents"), true, "a slash-prefixed name is not a command name");
});

test("an unknown command is treated as agent work", () => {
	// Refusing a real command is worse than forwarding one: the agent reports its own errors.
	assert.deepEqual(describeCommand("skill:go-testing"), { name: "skill:go-testing", kind: "agent" });
	assert.equal(isRunnableCommand("gentle:doctor"), true);
});

test("every terminal entry explains itself and only names a surface when one exists", () => {
	for (const name of ["gentle:agents", "gentle:panel", "gentle:jobs", "gentle:banner", "gentle:music"]) {
		const described = describeCommand(name);
		assert.equal(described.kind, "terminal", `${name} must be terminal`);
		assert.ok((described.note ?? "").length > 0, `${name} needs a note`);
	}
});
