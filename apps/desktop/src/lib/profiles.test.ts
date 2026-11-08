import assert from "node:assert/strict";
import test from "node:test";
import type { ProfileView, ProfilesActivation, ProfilesView } from "@gentle-shell/protocol";
import { activationPlan, addRoute, draftRoutes, isDirty, removeRoute, toDraft, updateRoute } from "./profiles.ts";

const alpha: ProfileView = {
	name: "alpha",
	mode: "organic",
	active: true,
	routes: [
		{ agent: "orchestrator", model: "anthropic/claude-opus-5-5", thinking: "high", tier: null },
		{ agent: "jd-judge-a", model: "openai/gpt-5", thinking: null, tier: "fast" },
	],
};

function view(): ProfilesView {
	return { state: "ok", reason: null, message: "", configHome: "/c", stored: true, active: "alpha", effective: null, profiles: [alpha], agents: [], notes: [] };
}

test("a draft starts as the stored profile, with unset fields as empty text for the inputs", () => {
	const draft = toDraft(alpha);
	assert.equal(draft.name, "alpha");
	assert.equal(draft.mode, "organic");
	assert.deepEqual(draft.routes[1], { agent: "jd-judge-a", model: "openai/gpt-5", thinking: "", tier: "fast" });
});

test("a draft that was not touched is not dirty, and reads back as the stored routes", () => {
	const draft = toDraft(alpha);
	assert.equal(isDirty(alpha, draft), false);
	assert.deepEqual(draftRoutes(draft), alpha.routes);
});

test("editing a route, the mode or the set of agents makes it dirty", () => {
	assert.equal(isDirty(alpha, updateRoute(toDraft(alpha), "jd-judge-a", { model: "openai/gpt-5-mini" })), true);
	assert.equal(isDirty(alpha, { ...toDraft(alpha), mode: "full-delegation" }), true);
	assert.equal(isDirty(alpha, addRoute(toDraft(alpha), "jd-judge-b")), true);
	assert.equal(isDirty(alpha, removeRoute(toDraft(alpha), "jd-judge-a")), true);
});

test("changing a field and changing it back is not an edit", () => {
	const there = updateRoute(toDraft(alpha), "jd-judge-a", { tier: "standard" });
	const back = updateRoute(there, "jd-judge-a", { tier: "fast" });
	assert.equal(isDirty(alpha, back), false);
});

test("typed text is trimmed and an empty field is sent as unset", () => {
	const draft = updateRoute(toDraft(alpha), "jd-judge-a", { model: "  openai/gpt-5-mini  ", tier: "" });
	assert.deepEqual(draftRoutes(draft)[1], { agent: "jd-judge-a", model: "openai/gpt-5-mini", thinking: null, tier: null });
});

test("an agent is added once, trimmed, and the orchestrator stays first", () => {
	const draft = addRoute(addRoute(removeRoute(toDraft(alpha), "orchestrator"), " jd-judge-b "), "orchestrator");
	assert.deepEqual(draft.routes.map((route) => route.agent), ["orchestrator", "jd-judge-a", "jd-judge-b"]);
	assert.deepEqual(addRoute(draft, "jd-judge-b").routes.length, draft.routes.length, "adding twice must not list it twice");
	assert.equal(addRoute(draft, "   ").routes.length, draft.routes.length, "a blank name adds nothing");
});

function activation(extra: Partial<ProfilesActivation>): ProfilesActivation {
	return { view: view(), orchestrator: null, pinnedTo: null, ...extra };
}

test("using a profile opens a new thread, then sets the orchestrator it selects", () => {
	const plan = activationPlan(activation({ orchestrator: { provider: "anthropic", model: "claude-opus-5-5", thinking: "high" } }));
	assert.deepEqual(plan.steps, [
		{ kind: "new-thread" },
		{ kind: "set-model", provider: "anthropic", modelId: "claude-opus-5-5" },
		{ kind: "set-thinking", level: "high" },
	]);
	assert.equal(plan.warning, null);
});

test("a profile with no orchestrator, or no thinking level, skips those steps", () => {
	assert.deepEqual(activationPlan(activation({})).steps, [{ kind: "new-thread" }]);
	assert.deepEqual(
		activationPlan(activation({ orchestrator: { provider: "openai", model: "gpt-5", thinking: null } })).steps,
		[{ kind: "new-thread" }, { kind: "set-model", provider: "openai", modelId: "gpt-5" }],
	);
});

test("a repository pin that wins is named, since it decides the subagents here", () => {
	const plan = activationPlan(activation({ pinnedTo: "quiet" }));
	assert.match(plan.warning ?? "", /quiet/);
});
