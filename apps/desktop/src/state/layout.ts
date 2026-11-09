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
	/** True when the rail is the narrow icon rail instead of the full one. */
	readonly collapsed: Accessor<boolean>;
	toggleRail(): void;
	setRailCollapsed(collapsed: boolean): void;
	toggleInspector(): void;
	resizeRail(width: number): void;
	resizeInspector(width: number): void;
	reset(): void;
}

/** The rail's own state: whether it is shrunk, and how wide the shrunk rail is. */
export interface RailMode {
	readonly collapsed: boolean;
	readonly width: number;
}

export const RAIL_MODE_KEY = "gentle-shell:ui-rail:v1";
export const DEFAULT_COLLAPSED_WIDTH = 56;
/** An icon rail stays a rail: enough for the glyph, never enough for a label. */
export const COLLAPSED_LIMITS = [48, 96] as const;
/** Dragged past this, the pointer is asking for the full rail back. */
const COLLAPSED_EXPAND_AT = COLLAPSED_LIMITS[1] + 24;

export const DEFAULT_RAIL_MODE: RailMode = { collapsed: false, width: DEFAULT_COLLAPSED_WIDTH };

/**
 * Read the rail's own state.
 *
 * The fallback is not a constant: a layout saved before the rail could shrink says `railOpen: false`
 * to mean "gone", so that value becomes "collapsed" instead of the rail silently disappearing on the
 * first launch after the upgrade.
 */
export function parseRailMode(raw: string | null, fallbackCollapsed: boolean): RailMode {
	const fallback: RailMode = { collapsed: fallbackCollapsed, width: DEFAULT_COLLAPSED_WIDTH };
	if (raw === null) return fallback;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return fallback;
	}
	if (typeof value !== "object" || value === null) return fallback;
	const record = value as Partial<Record<keyof RailMode, unknown>>;
	return {
		collapsed: typeof record.collapsed === "boolean" ? record.collapsed : fallback.collapsed,
		width: clampWidth(
			typeof record.width === "number" ? record.width : DEFAULT_COLLAPSED_WIDTH,
			COLLAPSED_LIMITS,
		),
	};
}

function read(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		// Storage can be unavailable (private mode, disabled cookies); the shell still has to work.
		return null;
	}
}

function restore(): { layout: Layout; rail: RailMode } {
	const layout = parseLayout(read(LAYOUT_KEY));
	return {
		// The rail is a mode now, not a presence: what used to be "closed" comes back shrunk.
		layout: { ...layout, railOpen: true },
		rail: parseRailMode(read(RAIL_MODE_KEY), !layout.railOpen),
	};
}

function remember(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Persisting is a convenience; losing it must not break the session.
	}
}

/**
 * The shell's arrangement: which panels are open and how wide they are.
 *
 * It remembers itself so the workspace you set up is the one you come back to, and every read is
 * clamped so a stored value can never trap a panel off screen. Closing the rail shrinks it to icons
 * rather than removing it, so `railOpen` is only ever false when the window is too narrow to hold it.
 */
export function createLayout(): LayoutController {
	const restored = restore();
	const [state, setState] = createSignal<Layout>(restored.layout);
	const [rail, setRail] = createSignal<RailMode>(restored.rail);
	const [viewport, setViewport] = createSignal(typeof window === "undefined" ? 0 : window.innerWidth);

	if (typeof window !== "undefined") {
		const onResize = (): void => {
			setViewport(window.innerWidth);
		};
		window.addEventListener("resize", onResize);
		onCleanup(() => window.removeEventListener("resize", onResize));
	}

	/** The rail's stored width is the open one; while shrunk, the icon rail's own width wins. */
	const effective = (): Layout => {
		const resolved = resolveLayout(state(), viewport());
		const mode = rail();
		return resolved.railOpen && mode.collapsed ? { ...resolved, railWidth: mode.width } : resolved;
	};

	createEffect(() => {
		remember(LAYOUT_KEY, serializeLayout(state()));
	});
	createEffect(() => {
		const mode = rail();
		remember(RAIL_MODE_KEY, JSON.stringify(mode));
	});

	const patch = (change: Partial<Layout>): void => {
		setState((current) => ({ ...current, ...change }));
	};

	const setRailCollapsed = (collapsed: boolean): void => {
		setRail((current) => ({ ...current, collapsed }));
		// Expanding has to bring the rail back even if a narrow window or an old layout hid it.
		if (!collapsed) patch({ railOpen: true });
	};

	return {
		state,
		effective,
		collapsed: () => rail().collapsed,
		toggleRail: () => setRailCollapsed(!rail().collapsed),
		setRailCollapsed,
		toggleInspector: () => patch({ inspectorOpen: !state().inspectorOpen }),
		resizeRail: (width: number) => {
			const mode = rail();
			if (!mode.collapsed) {
				patch({ railWidth: clampWidth(width, RAIL_LIMITS) });
				return;
			}
			// The divider is still the rail's handle while shrunk: dragging it out brings the rail back.
			if (width >= COLLAPSED_EXPAND_AT) {
				setRailCollapsed(false);
				patch({ railWidth: clampWidth(width, RAIL_LIMITS) });
				return;
			}
			setRail((current) => ({ ...current, width: clampWidth(width, COLLAPSED_LIMITS) }));
		},
		resizeInspector: (width: number) => patch({ inspectorWidth: clampWidth(width, INSPECTOR_LIMITS) }),
		reset: () => {
			setState(DEFAULT_LAYOUT);
			setRail(DEFAULT_RAIL_MODE);
		},
	};
}
