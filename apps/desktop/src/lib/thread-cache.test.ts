import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@gentle-shell/protocol";
import { MAX_CACHED_THREADS, readCachedThreads, writeCachedThreads, type TextStorage } from "./thread-cache.ts";

function memory(initial: Record<string, string> = {}): TextStorage & { data: Record<string, string> } {
	const data = { ...initial };
	return {
		data,
		getItem: (key) => data[key] ?? null,
		setItem: (key, value) => {
			data[key] = value;
		},
	};
}

function thread(n: number, extra: Partial<SessionSummary> = {}): SessionSummary {
	return { path: `/s/${n}.jsonl`, cwd: "/work", title: `thread ${n}`, updatedAt: 1_700_000_000_000 - n, ...extra };
}

test("a saved list comes back as it was, in order", () => {
	const storage = memory();
	const list = [thread(1, { model: "claude" }), thread(2), thread(3, { cwd: "" })];
	writeCachedThreads(storage, list);
	assert.deepEqual(readCachedThreads(storage), list);
});

test("nothing cached reads as an empty list", () => {
	assert.deepEqual(readCachedThreads(memory()), []);
});

test("a cache that is not JSON, or not a list, is ignored instead of breaking the rail", () => {
	assert.deepEqual(readCachedThreads(memory({ "gentle-shell:threads:v1": "{not json" })), []);
	assert.deepEqual(readCachedThreads(memory({ "gentle-shell:threads:v1": '{"a":1}' })), []);
});

test("entries that do not have the shape of a thread are dropped one by one", () => {
	const storage = memory({
		"gentle-shell:threads:v1": JSON.stringify([thread(1), { path: 3 }, null, "x", { ...thread(2), updatedAt: "yesterday" }, thread(3)]),
	});
	assert.deepEqual(readCachedThreads(storage).map((entry) => entry.title), ["thread 1", "thread 3"]);
});

test("only the newest threads are kept, so a large index cannot fill the storage", () => {
	const storage = memory();
	writeCachedThreads(storage, Array.from({ length: MAX_CACHED_THREADS + 40 }, (_, n) => thread(n)));
	const kept = readCachedThreads(storage);
	assert.equal(kept.length, MAX_CACHED_THREADS);
	assert.equal(kept[0]?.title, "thread 0");
});

test("a storage that refuses to read or write is not an error", () => {
	const broken: TextStorage = {
		getItem: () => {
			throw new Error("blocked");
		},
		setItem: () => {
			throw new Error("quota");
		},
	};
	assert.deepEqual(readCachedThreads(broken), []);
	assert.doesNotThrow(() => writeCachedThreads(broken, [thread(1)]));
});
