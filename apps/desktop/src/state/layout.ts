import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import {
	DEFAULT_LAYOUT,
	resolveLayout,
	INSPECTOR_LIMITS,
	LAYOUT_KEY,
	RAIL_LIMITS,
	clampWidth,
	parseLayout,
	serializeLayout,
	type Layout,
} from "../lib/layout";

export interface LayoutController {
	readonly state: Accessor<Layout>;
	/** The layout as the window width allows it, which is what the shell renders. */
	readonly effective: Accessor<Layout>;
	toggleRail(): void;
	toggleInspector(): void;
	resizeRail(width: number): void;
	resizeInspector(width: number): void;
	reset(): void;
}

function restore(): Layout {
	try {
		return parseLayout(window.localStorage.getItem(LAYOUT_KEY));
	} catch {
		// Storage can be unavailable (private mode, disabled cookies); the shell still has to work.
		return DEFAULT_LAYOUT;
	}
}

/**
 * The shell's arrangement: which panels are open and how wide they are.
 *
 * It remembers itself so the workspace you set up is the one you come back to, and every read is
 * clamped so a stored value can never trap a panel off screen.
 */
export function createLayout(): LayoutController {
	const [state, setState] = createSignal<Layout>(restore());
	const [viewport, setViewport] = createSignal(typeof window === "undefined" ? 0 : window.innerWidth);

	if (typeof window !== "undefined") {
		const onResize = (): void => {
			setViewport(window.innerWidth);
		};
		window.addEventListener("resize", onResize);
		onCleanup(() => window.removeEventListener("resize", onResize));
	}

	const effective = (): Layout => resolveLayout(state(), viewport());

	createEffect(() => {
		const snapshot = state();
		try {
			window.localStorage.setItem(LAYOUT_KEY, serializeLayout(snapshot));
		} catch {
			// Persisting is a convenience; losing it must not break the session.
		}
	});

	const patch = (change: Partial<Layout>): void => {
		setState((current) => ({ ...current, ...change }));
	};

	return {
		state,
		effective,
		toggleRail: () => patch({ railOpen: !state().railOpen }),
		toggleInspector: () => patch({ inspectorOpen: !state().inspectorOpen }),
		resizeRail: (width: number) => patch({ railWidth: clampWidth(width, RAIL_LIMITS) }),
		resizeInspector: (width: number) => patch({ inspectorWidth: clampWidth(width, INSPECTOR_LIMITS) }),
		reset: () => setState(DEFAULT_LAYOUT),
	};
}
