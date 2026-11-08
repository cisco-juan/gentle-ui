import { createSignal, untrack, type Accessor } from "solid-js";
import type { MemoryContextView, MemoryObservation, MemoryProjectsView, MemorySearchView } from "@gentle-shell/protocol";
import type { BridgeClient } from "../lib/bridge";

/**
 * Memory panel state.
 *
 * Engram's answers are not mirrored here: the panel asks the bridge and renders what comes back.
 * Two rules follow from the panel being read-only.
 * - There is no save, update or delete path in this module at all, and no method that could grow one
 *   without a new bridge action: `refresh` and `search` are the whole vocabulary.
 * - An empty list is never composed here. A memory that could not be asked arrives as a typed
 *   `unavailable` (or `unparsable`) answer with its reason, and the panel shows that reason instead
 *   of an empty frame that would read as "you have no memories".
 */

/** The inspector's sixth tab; the inspector imports this entry instead of a bare string. */
export const MEMORY_TAB = { id: "memory", label: "Memory" } as const;

export interface MemoryView {
	/** The project Engram derived for this workspace, with its counts. */
	readonly context: MemoryContextView | null;
	/** The last search, or null before one was asked. */
	readonly results: MemorySearchView | null;
	/** Engram's project index, read alongside the context. */
	readonly projects: MemoryProjectsView | null;
	readonly loading: boolean;
	readonly searching: boolean;
	readonly error: string | null;
	/** The row whose text is expanded in place; null when nothing is selected. */
	readonly selectedId: string | null;
}

export interface MemoryPanel {
	readonly view: Accessor<MemoryView>;
	refresh(): Promise<void>;
	search(query: string): Promise<void>;
	/** Expand one result in place, or collapse it when it is already open. */
	select(id: string): void;
	stop(): void;
}

const EMPTY_VIEW: MemoryView = {
	context: null,
	results: null,
	projects: null,
	loading: false,
	searching: false,
	error: null,
	selectedId: null,
};

/** One type's worth of hits, because the panel groups by the observation's own `type`. */
export interface MemoryTypeGroup {
	/** The observation type; "" for a payload that did not name one. */
	readonly type: string;
	readonly observations: readonly MemoryObservation[];
}

/**
 * Group hits by type, keeping the server's order inside a group.
 *
 * Types are sorted by name so a repeated search does not reshuffle the panel, and an observation
 * without a type lands in one honest group instead of inventing a category for it.
 */
export function groupByType(observations: readonly MemoryObservation[]): readonly MemoryTypeGroup[] {
	const groups = new Map<string, MemoryObservation[]>();
	for (const observation of observations) {
		const type = observation.type.trim();
		const existing = groups.get(type);
		if (existing === undefined) groups.set(type, [observation]);
		else existing.push(observation);
	}
	return [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([type, entries]) => ({ type, observations: entries }));
}

/** Create the panel. Call it from a component so any future effect has an owner. */
export function createMemoryPanel(options: { readonly connect: () => BridgeClient | null }): MemoryPanel {
	const [view, setView] = createSignal<MemoryView>(EMPTY_VIEW);

	// One generation per kind of read: a slow answer cannot overwrite a newer one of its own kind.
	// They are separate because a read that is overtaken returns without touching the view, so when a
	// refresh and a search shared one counter the overtaken one never cleared its own busy flag and
	// its button stayed on "reading…" or "asking…" for good. A refresh reads the project, a search
	// reads results for it: neither makes the other's answer wrong.
	let refreshRun = 0;
	let searchRun = 0;
	let stopped = false;

	async function refresh(): Promise<void> {
		const client = options.connect();
		const current = ++refreshRun;
		if (client === null) {
			setView((value) => ({ ...value, loading: false, error: "the bridge is not connected" }));
			return;
		}

		setView((value) => ({ ...value, loading: true, error: null }));
		let context: MemoryContextView;
		let projects: MemoryProjectsView;
		try {
			[context, projects] = await Promise.all([
				client.memory({ action: "context" }),
				client.memory({ action: "projects" }),
			]);
		} catch (error) {
			if (current !== refreshRun || stopped) return;
			setView((value) => ({ ...value, context: null, projects: null, loading: false, error: messageOf(error) }));
			return;
		}
		if (current !== refreshRun || stopped) return;
		setView((value) => ({ ...value, context, projects, loading: false, error: null }));
	}

	async function search(query: string): Promise<void> {
		const asked = query.trim();
		if (asked.length === 0) {
			setView((value) => ({ ...value, error: "a memory search needs a query" }));
			return;
		}

		const client = options.connect();
		if (client === null) {
			setView((value) => ({ ...value, error: "the bridge is not connected" }));
			return;
		}

		const current = ++searchRun;
		setView((value) => ({ ...value, searching: true, error: null }));
		try {
			const results = await client.memory({ action: "search", query: asked });
			if (current !== searchRun || stopped) return;
			setView((value) => ({ ...value, results, searching: false, selectedId: null }));
		} catch (error) {
			if (current !== searchRun || stopped) return;
			setView((value) => ({ ...value, results: null, searching: false, error: messageOf(error) }));
		}
	}

	function select(id: string): void {
		const current = untrack(() => view().selectedId);
		setView((value) => ({ ...value, selectedId: current === id ? null : id }));
	}

	function stop(): void {
		stopped = true;
		refreshRun += 1;
		searchRun += 1;
	}

	return { view, refresh, search, select, stop };
}

/** What the head chip says when there is no project to name. */
export function projectLabel(context: MemoryContextView | null): string {
	if (context === null) return "not read yet";
	if (context.project.length > 0) return context.project;
	return context.state === "ok" ? "no project" : "memory unavailable";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
