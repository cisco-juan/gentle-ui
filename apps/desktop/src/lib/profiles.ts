import type { ProfileMode, ProfileRoute, ProfileView, ProfilesActivation } from "@gentle-shell/protocol";

/** The thinking levels and service tiers gentle-pi accepts; anything else its reader would drop. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const TIERS = ["standard", "fast"] as const;
export const ORCHESTRATOR = "orchestrator";

/** One row of the editor. Unset fields are empty text, because that is what an input holds. */
export interface DraftRoute {
	readonly agent: string;
	readonly model: string;
	readonly thinking: string;
	readonly tier: string;
}

export interface ProfileDraft {
	readonly name: string;
	readonly mode: ProfileMode;
	readonly routes: readonly DraftRoute[];
}

export function toDraft(profile: ProfileView): ProfileDraft {
	return {
		name: profile.name,
		mode: profile.mode,
		routes: profile.routes.map((route) => ({
			agent: route.agent,
			model: route.model ?? "",
			thinking: route.thinking ?? "",
			tier: route.tier ?? "",
		})),
	};
}

/** What the bridge is sent: text trimmed, and an empty field as unset. */
export function draftRoutes(draft: ProfileDraft): ProfileRoute[] {
	return draft.routes.map((route) => ({
		agent: route.agent.trim(),
		model: orNull(route.model),
		thinking: orNull(route.thinking),
		tier: orNull(route.tier),
	}));
}

/** True when saving would change something: the mode, the set of agents, or any value. */
export function isDirty(profile: ProfileView, draft: ProfileDraft): boolean {
	if (profile.mode !== draft.mode) return true;
	return signature(toDraft(profile).routes) !== signature(draft.routes);
}

export function updateRoute(draft: ProfileDraft, agent: string, patch: Partial<Omit<DraftRoute, "agent">>): ProfileDraft {
	return { ...draft, routes: draft.routes.map((route) => (route.agent === agent ? { ...route, ...patch } : route)) };
}

export function removeRoute(draft: ProfileDraft, agent: string): ProfileDraft {
	return { ...draft, routes: draft.routes.filter((route) => route.agent !== agent) };
}

/** Add an agent once; the orchestrator goes first because it is the one every profile means. */
export function addRoute(draft: ProfileDraft, agent: string): ProfileDraft {
	const name = agent.trim();
	if (name.length === 0 || draft.routes.some((route) => route.agent === name)) return draft;
	const row: DraftRoute = { agent: name, model: "", thinking: "", tier: "" };
	return { ...draft, routes: name === ORCHESTRATOR ? [row, ...draft.routes] : [...draft.routes, row] };
}

export type ActivationStep =
	| { readonly kind: "new-thread" }
	| { readonly kind: "set-model"; readonly provider: string; readonly modelId: string }
	| { readonly kind: "set-thinking"; readonly level: string };

export interface ActivationPlan {
	readonly steps: readonly ActivationStep[];
	/** Something the person should know that is not an error, or null. */
	readonly warning: string | null;
}

/**
 * What "use this profile" does once the bridge has made it the default: open a new thread, which starts
 * with the profile, then point that thread's model at the orchestrator the profile selects. The open
 * thread is never changed, because binding a running session needs Pi's own process.
 */
export function activationPlan(activation: ProfilesActivation): ActivationPlan {
	const steps: ActivationStep[] = [{ kind: "new-thread" }];
	if (activation.orchestrator !== null) {
		steps.push({ kind: "set-model", provider: activation.orchestrator.provider, modelId: activation.orchestrator.model });
		if (activation.orchestrator.thinking !== null) steps.push({ kind: "set-thinking", level: activation.orchestrator.thinking });
	}
	const warning =
		activation.pinnedTo === null
			? null
			: `This repository pins its subagent routing to "${activation.pinnedTo}", so subagents in new threads here follow that profile. The orchestrator follows the one you chose.`;
	return { steps, warning };
}

function orNull(value: string): string | null {
	const text = value.trim();
	return text.length === 0 ? null : text;
}

function signature(routes: readonly DraftRoute[]): string {
	return JSON.stringify(
		routes
			.map((route) => [route.agent.trim(), route.model.trim(), route.thinking.trim(), route.tier.trim()])
			.sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
	);
}
