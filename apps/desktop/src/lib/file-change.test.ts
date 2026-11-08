import assert from "node:assert/strict";
import test from "node:test";
import { fileChangeOf, lineCountOf, writeTextOf } from "./file-change.ts";

test("a write reports the file and how many lines it holds", () => {
	assert.deepEqual(fileChangeOf("write", { path: "/tmp/a.ts", content: "one\ntwo\nthree" }), {
		path: "/tmp/a.ts",
		kind: "write",
		lines: 3,
	});
	// A trailing newline ends the last line; it does not start another one.
	assert.deepEqual(fileChangeOf("write", { file_path: "/tmp/a.ts", content: "one\ntwo\n" }), {
		path: "/tmp/a.ts",
		kind: "write",
		lines: 2,
	});
});

test("a write with no usable content is an empty file, not a crash", () => {
	for (const content of [undefined, null, "", 42, ["x"], { text: "x" }]) {
		assert.deepEqual(fileChangeOf("write", { path: "/a", content }), { path: "/a", kind: "write", lines: 0 }, `content ${JSON.stringify(content)}`);
	}
});

test("an edit keeps its replacements in order, as hunks", () => {
	assert.deepEqual(
		fileChangeOf("edit", {
			path: "/b.ts",
			edits: [
				{ oldText: "a", newText: "A" },
				{ oldText: "b\nc", newText: "B" },
			],
		}),
		{
			path: "/b.ts",
			kind: "edit",
			hunks: [
				{ removed: "a", added: "A" },
				{ removed: "b\nc", added: "B" },
			],
		},
	);
});

test("an edit sent as a JSON string still shows its hunks", () => {
	const edits = JSON.stringify([{ oldText: "x", newText: "y" }]);
	assert.deepEqual(fileChangeOf("edit", { file_path: "/c.ts", edits }), {
		path: "/c.ts",
		kind: "edit",
		hunks: [{ removed: "x", added: "y" }],
	});
});

test("an unparseable edits string is no change at all", () => {
	assert.equal(fileChangeOf("edit", { path: "/c.ts", edits: "{not json" }), null);
});

test("a single edit object works where an array was expected", () => {
	assert.deepEqual(fileChangeOf("edit", { path: "/d.ts", edits: { oldText: "p", newText: "q" } }), {
		path: "/d.ts",
		kind: "edit",
		hunks: [{ removed: "p", added: "q" }],
	});
});

test("a hunk that only adds or only removes lines is still a change", () => {
	assert.deepEqual(fileChangeOf("edit", { path: "/e.ts", edits: [{ oldText: "", newText: "new" }] }), {
		path: "/e.ts",
		kind: "edit",
		hunks: [{ removed: "", added: "new" }],
	});
});

test("tools that do not change a file have no file change", () => {
	assert.equal(fileChangeOf("bash", { command: "ls", path: "/e", content: "x" }), null);
	assert.equal(fileChangeOf("read", { path: "/e" }), null);
	assert.equal(fileChangeOf("codemode", { path: "/e", content: "x", edits: [{ oldText: "a", newText: "b" }] }), null);
});

test("a change with no file has no card", () => {
	assert.equal(fileChangeOf("write", { content: "x" }), null);
	assert.equal(fileChangeOf("write", { path: "", content: "x" }), null);
	assert.equal(fileChangeOf("write", { path: 7, content: "x" }), null);
	assert.equal(fileChangeOf("edit", { file_path: null, edits: [{ oldText: "a", newText: "b" }] }), null);
});

test("an edit with no usable hunk has no card", () => {
	assert.equal(fileChangeOf("edit", { path: "/f.ts" }), null);
	assert.equal(fileChangeOf("edit", { path: "/f.ts", edits: [] }), null);
	assert.equal(fileChangeOf("edit", { path: "/f.ts", edits: [{ oldText: "a", newText: "b" }] }) === null, false);
	assert.equal(fileChangeOf("edit", { path: "/f.ts", edits: [{ oldText: "", newText: "" }] }), null);
	assert.equal(fileChangeOf("edit", { path: "/f.ts", edits: [{ oldText: 1, newText: 2 }] }), null);
	assert.equal(fileChangeOf("edit", { path: "/f.ts", edits: [null, "nope", [], { oldText: "a" }] }), null);
});

test("hostile arguments return null instead of throwing", () => {
	const deep: Record<string, unknown> = {};
	let cursor = deep;
	for (let index = 0; index < 5000; index += 1) {
		const next: Record<string, unknown> = {};
		cursor.next = next;
		cursor = next;
	}
	const proto = JSON.parse('{"__proto__": {"path": "/x", "content": "x"}, "constructor": 1}');
	const hostile: unknown[] = [
		null,
		undefined,
		0,
		"",
		[],
		[1, 2],
		() => "x",
		proto,
		deep,
		{ path: "/g", content: { toString: 1 } },
		{ path: "/g", edits: 5 },
		{ path: "/g", edits: { oldText: {}, newText: [] } },
		{ path: [], content: "x" },
	];
	for (const args of hostile) {
		assert.doesNotThrow(() => fileChangeOf("write", args));
		assert.doesNotThrow(() => fileChangeOf("edit", args));
	}
});

test("the written text and its line count are visible to the card", () => {
	assert.equal(writeTextOf({ content: "a\nb" }), "a\nb");
	assert.equal(writeTextOf({ content: 3 }), "");
	assert.equal(writeTextOf(null), "");
	assert.equal(lineCountOf(""), 0);
	assert.equal(lineCountOf("one"), 1);
	assert.equal(lineCountOf("one\n"), 1);
	assert.equal(lineCountOf("one\ntwo"), 2);
});
