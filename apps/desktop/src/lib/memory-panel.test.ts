import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryPanel } from "../state/memory.ts";

/** A promise the test settles by hand, so it decides which of two overlapping reads answers first. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const CONTEXT = { state: "ok", project: "demo" };
const PROJECTS = { state: "ok", count: 1, projects: [] };
const RESULTS = { state: "ok", query: "x", observations: [] };

/** A bridge whose memory answers are the ones the test hands out, in the order it asks for them. */
function fakeBridge() {
	const contexts: Array<ReturnType<typeof deferred<unknown>>> = [];
	const searches: Array<ReturnType<typeof deferred<unknown>>> = [];
	const client = {
		memory(request: { action: string }): Promise<unknown> {
			if (request.action === "search") {
				const next = deferred<unknown>();
				searches.push(next);
				return next.promise;
			}
			if (request.action === "projects") return Promise.resolve(PROJECTS);
			const next = deferred<unknown>();
			contexts.push(next);
			return next.promise;
		},
	};
	return { client: client as never, contexts, searches };
}

test("a refresh overtaken by a search still ends its own loading", async () => {
	const { client, contexts, searches } = fakeBridge();
	const panel = createMemoryPanel({ connect: () => client });

	const refreshing = panel.refresh();
	const searching = panel.search("x");
	contexts[0]?.resolve(CONTEXT);
	searches[0]?.resolve(RESULTS);
	await Promise.all([refreshing, searching]);

	assert.equal(panel.view().loading, false, "the refresh button stays on reading…");
	assert.equal(panel.view().searching, false);
});

test("a search overtaken by a refresh still ends its own searching", async () => {
	const { client, contexts, searches } = fakeBridge();
	const panel = createMemoryPanel({ connect: () => client });

	const searching = panel.search("x");
	const refreshing = panel.refresh();
	contexts[0]?.resolve(CONTEXT);
	searches[0]?.resolve(RESULTS);
	await Promise.all([searching, refreshing]);

	assert.equal(panel.view().searching, false, "the search button stays on asking…");
	assert.equal(panel.view().loading, false);
});

test("two refreshes in a row settle on the newer answer and are not left loading", async () => {
	const { client, contexts } = fakeBridge();
	const panel = createMemoryPanel({ connect: () => client });

	const first = panel.refresh();
	const second = panel.refresh();
	contexts[1]?.resolve({ ...CONTEXT, project: "newer" });
	contexts[0]?.resolve({ ...CONTEXT, project: "older" });
	await Promise.all([first, second]);

	assert.equal(panel.view().loading, false);
	assert.equal((panel.view().context as { project: string }).project, "newer", "a slow older answer won");
});

test("a stopped panel renders nothing that arrives afterwards", async () => {
	const { client, contexts } = fakeBridge();
	const panel = createMemoryPanel({ connect: () => client });

	const refreshing = panel.refresh();
	panel.stop();
	contexts[0]?.resolve(CONTEXT);
	await refreshing;

	assert.equal(panel.view().context, null);
});
