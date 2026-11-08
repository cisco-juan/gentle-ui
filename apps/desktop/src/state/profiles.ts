import { createSignal, type Accessor } from "solid-js";
import type { ProfileMode, ProfileRoute, ProfilesActivation, ProfilesView } from "@gentle-shell/protocol";
import type { BridgeClient } from "../lib/bridge";
import { activationPlan } from "../lib/profiles.ts";

/**
 * Profiles panel state.
 *
 * What the bridge answers is not mirrored here: every change comes back as the whole list as it now is on
 * disk, and that is what the sheet renders. `data` is kept whole, `unavailable` included, so the sheet can
 * say why there is nothing to edit instead of showing an empty list that reads as "you have no profiles".
 */

export interface ProfilesPanelView {
	/** The last answer, or null before the first one. */
	readonly data: ProfilesView | null;
	readonly loading: boolean;
	/** A change is in flight; the controls that would start another are off. */
	readonly busy: boolean;
	readonly error: string | null;
	/** Something to tell the person that is not an error, such as a pin that wins over the new default. */
	readonly notice: string | null;
	readonly selected: string | null;
}

export interface ProfilesPanelOptions {
	readonly connect: () => BridgeClient | null;
	/** Open a fresh thread, which starts with the profile that is now the default. */
	readonly newThread: () => Promise<void>;
	readonly setModel: (provider: string, modelId: string) => Promise<void>;
	readonly setThinking: (level: string) => Promise<void>;
}

export interface ProfilesPanel {
	readonly view: Accessor<ProfilesPanelView>;
	/** The profile new threads start with, for the composer chip: "default" until the first answer. */
	effectiveName(): string;
	refresh(): Promise<void>;
	select(name: string): void;
	save(name: string, routes: readonly ProfileRoute[], mode: ProfileMode): Promise<void>;
	create(name: string, from?: string): Promise<void>;
	rename(name: string, to: string): Promise<void>;
	remove(name: string): Promise<void>;
	/** Make a profile the default, then open a thread that starts with it and set its orchestrator. */
	use(name: string): Promise<void>;
	stop(): void;
}

const EMPTY: ProfilesPanelView = { data: null, loading: false, busy: false, error: null, notice: null, selected: null };

export function createProfilesPanel(options: ProfilesPanelOptions): ProfilesPanel {
	const [view, setView] = createSignal<ProfilesPanelView>(EMPTY);

	// A slow read cannot overwrite a newer one. Changes have no generation of their own: they are
	// started by a click, the controls are off while one runs, and each answer is the whole truth.
	let refreshRun = 0;
	let stopped = false;

	function apply(data: ProfilesView, selectName?: string): void {
		setView((value) => ({
			...value,
			data,
			error: null,
			selected: selectName !== undefined && data.profiles.some((profile) => profile.name === selectName) ? selectName : keepSelection(value.selected, data),
		}));
	}

	async function refresh(): Promise<void> {
		const client = options.connect();
		const current = ++refreshRun;
		if (client === null) {
			setView((value) => ({ ...value, loading: false, error: "the bridge is not connected" }));
			return;
		}

		setView((value) => ({ ...value, loading: true, error: null }));
		try {
			const data = await client.profiles({ action: "list" });
			if (current !== refreshRun || stopped) return;
			apply(data);
			setView((value) => ({ ...value, loading: false }));
		} catch (error) {
			if (current !== refreshRun || stopped) return;
			setView((value) => ({ ...value, loading: false, error: messageOf(error) }));
		}
	}

	/** Run one change; its answer replaces the list, and a refusal leaves the list as it was. */
	async function change(run: (client: BridgeClient) => Promise<ProfilesView>, selectName?: string): Promise<void> {
		const client = options.connect();
		if (client === null) {
			setView((value) => ({ ...value, error: "the bridge is not connected" }));
			return;
		}
		setView((value) => ({ ...value, busy: true, error: null, notice: null }));
		try {
			const data = await run(client);
			if (!stopped) apply(data, selectName);
		} catch (error) {
			if (!stopped) setView((value) => ({ ...value, error: messageOf(error) }));
		} finally {
			if (!stopped) setView((value) => ({ ...value, busy: false }));
		}
	}

	async function use(name: string): Promise<void> {
		const client = options.connect();
		if (client === null) {
			setView((value) => ({ ...value, error: "the bridge is not connected" }));
			return;
		}
		setView((value) => ({ ...value, busy: true, error: null, notice: null }));

		let activation: ProfilesActivation;
		try {
			activation = await client.profiles({ action: "activate", name });
		} catch (error) {
			if (!stopped) setView((value) => ({ ...value, busy: false, error: messageOf(error) }));
			return;
		}
		if (stopped) return;
		apply(activation.view);

		// Each step is tried on its own: a model that is gone must not stop the thread from opening.
		const plan = activationPlan(activation);
		const failures: string[] = [];
		for (const step of plan.steps) {
			try {
				if (step.kind === "new-thread") await options.newThread();
				else if (step.kind === "set-model") await options.setModel(step.provider, step.modelId);
				else await options.setThinking(step.level);
			} catch (error) {
				failures.push(messageOf(error));
			}
		}
		if (stopped) return;
		setView((value) => ({
			...value,
			busy: false,
			error: failures.length === 0 ? null : failures.join("; "),
			notice: plan.warning ?? `"${name}" is now the default, and a new thread started with it.`,
		}));
	}

	return {
		view,
		effectiveName: () => view().data?.effective?.name ?? view().data?.active ?? "default",
		refresh,
		select: (name) => setView((value) => ({ ...value, selected: name, notice: null })),
		save: (name, routes, mode) => change((client) => client.profiles({ action: "save", name, routes, mode })),
		create: (name, from) =>
			change((client) => client.profiles({ action: "create", name, ...(from === undefined ? {} : { from }) }), name),
		rename: (name, to) => change((client) => client.profiles({ action: "rename", name, to }), to),
		remove: (name) => change((client) => client.profiles({ action: "delete", name })),
		use,
		stop: () => {
			stopped = true;
			refreshRun += 1;
		},
	};
}

/** Keep the chosen profile if it still exists, else the one new threads start with, else the first. */
function keepSelection(current: string | null, data: ProfilesView): string | null {
	const names = data.profiles.map((profile) => profile.name);
	if (current !== null && names.includes(current)) return current;
	const effective = data.effective?.name;
	if (effective !== undefined && names.includes(effective)) return effective;
	return names[0] ?? null;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
