import assert from "node:assert/strict";
import test from "node:test";
import type { ProfilesActivation, ProfilesView } from "@gentle-shell/protocol";
import { createProfilesPanel } from "../state/profiles.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function view(names: string[], active: string | null = names[0] ?? null, state: "ok" | "unavailable" = "ok"): ProfilesView {
	return {
		state,
		reason: state === "ok" ? null : "library-missing",
		message: state === "ok" ? "" : "gentle-pi is not installed",
		configHome: "/c",
		stored: true,
		active,
		effective: active === null ? null : { name: active, source: "active" },
		profiles: names.map((name) => ({ name, mode: "organic", active: name === active, routes: [] })),
		agents: [],
		notes: [],
	};
}

type Request = { action: string; name?: string; from?: string; to?: string };

/** A bridge whose profile answers are the ones the test hands out, in the order it asks for them. */
function fakeBridge(answer: (request: Request) => Promise<unknown>) {
	const seen: Request[] = [];
	return {
		seen,
		client: {
			profiles(request: Request): Promise<unknown> {
				seen.push(request);
				return answer(request);
			},
		} as never,
	};
}

function panelOver(bridge: ReturnType<typeof fakeBridge>, steps: string[] = []) {
	return createProfilesPanel({
		connect: () => bridge.client,
		newThread: async () => void steps.push("new-thread"),
		setModel: async (provider, modelId) => void steps.push(`model ${provider}/${modelId}`),
		setThinking: async (level) => void steps.push(`thinking ${level}`),
	});
}

test("with nothing read yet the chip names the default profile", () => {
	const panel = panelOver(fakeBridge(async () => view([])));
	assert.equal(panel.effectiveName(), "default");
});

test("a refresh fills the list, selects the profile new threads start with, and names it for the chip", async () => {
	const panel = panelOver(fakeBridge(async () => view(["alpha", "beta"], "beta")));
	await panel.refresh();
	assert.equal(panel.view().data?.profiles.length, 2);
	assert.equal(panel.view().selected, "beta");
	assert.equal(panel.effectiveName(), "beta");
	assert.equal(panel.view().loading, false);
});

test("two refreshes in a row settle on the newer answer and are not left loading", async () => {
	const first = deferred<ProfilesView>();
	const second = deferred<ProfilesView>();
	const answers = [first, second];
	const panel = panelOver(fakeBridge(() => (answers.shift() as typeof first).promise));

	const one = panel.refresh();
	const two = panel.refresh();
	second.resolve(view(["newer"]));
	first.resolve(view(["older"]));
	await Promise.all([one, two]);

	assert.deepEqual(panel.view().data?.profiles.map((profile) => profile.name), ["newer"]);
	assert.equal(panel.view().loading, false);
});

test("a change that is refused keeps what was on screen and says why", async () => {
	let first = true;
	const panel = panelOver(
		fakeBridge(async () => {
			if (first) {
				first = false;
				return view(["alpha"]);
			}
			throw new Error("Profile already exists: alpha.");
		}),
	);
	await panel.refresh();
	await panel.create("alpha");

	assert.equal(panel.view().error, "Profile already exists: alpha.");
	assert.deepEqual(panel.view().data?.profiles.map((profile) => profile.name), ["alpha"]);
	assert.equal(panel.view().busy, false);
});

test("a change that works replaces the list with the one the bridge answered", async () => {
	const panel = panelOver(fakeBridge(async (request) => (request.action === "list" ? view(["alpha"]) : view(["alpha", "gamma"]))));
	await panel.refresh();
	await panel.create("gamma", "alpha");
	assert.deepEqual(panel.view().data?.profiles.map((profile) => profile.name), ["alpha", "gamma"]);
	assert.equal(panel.view().error, null);
});

test("deleting the selected profile moves the selection to one that exists", async () => {
	const panel = panelOver(fakeBridge(async (request) => (request.action === "delete" ? view(["alpha"]) : view(["alpha", "beta"], "alpha"))));
	await panel.refresh();
	panel.select("beta");
	await panel.remove("beta");
	assert.equal(panel.view().selected, "alpha");
});

test("an unavailable library is kept as it is, with its reason, instead of becoming an empty list", async () => {
	const panel = panelOver(fakeBridge(async () => view([], null, "unavailable")));
	await panel.refresh();
	assert.equal(panel.view().data?.state, "unavailable");
	assert.equal(panel.view().data?.reason, "library-missing");
});

test("using a profile activates it, then opens a thread and sets the orchestrator, in that order", async () => {
	const steps: string[] = [];
	const activation: ProfilesActivation = {
		view: view(["alpha", "beta"], "beta"),
		orchestrator: { provider: "openai", model: "gpt-5", thinking: "low" },
		pinnedTo: null,
	};
	const bridge = fakeBridge(async (request) => (request.action === "activate" ? activation : view(["alpha", "beta"])));
	const panel = panelOver(bridge, steps);
	await panel.refresh();
	await panel.use("beta");

	assert.deepEqual(steps, ["new-thread", "model openai/gpt-5", "thinking low"]);
	assert.equal(panel.effectiveName(), "beta");
});

test("if setting the model fails the thread is still opened and the failure is shown", async () => {
	const steps: string[] = [];
	const activation: ProfilesActivation = {
		view: view(["beta"], "beta"),
		orchestrator: { provider: "openai", model: "gpt-5", thinking: "low" },
		pinnedTo: "quiet",
	};
	const panel = createProfilesPanel({
		connect: () => fakeBridge(async () => activation).client,
		newThread: async () => void steps.push("new-thread"),
		setModel: async () => {
			throw new Error("Model not found: openai/gpt-5");
		},
		setThinking: async (level) => void steps.push(`thinking ${level}`),
	});
	await panel.use("beta");

	assert.deepEqual(steps, ["new-thread", "thinking low"]);
	assert.match(panel.view().error ?? "", /Model not found/);
	assert.match(panel.view().notice ?? "", /quiet/, "the pin warning must still be shown");
});

test("no bridge is an error the person can read, not a silent no-op", async () => {
	const panel = createProfilesPanel({
		connect: () => null,
		newThread: async () => undefined,
		setModel: async () => undefined,
		setThinking: async () => undefined,
	});
	await panel.refresh();
	assert.match(panel.view().error ?? "", /not connected/);
});
