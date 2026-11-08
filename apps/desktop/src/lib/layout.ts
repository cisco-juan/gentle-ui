/** Layout model: what the shell remembers about how you arranged it. */

export interface Layout {
	readonly railOpen: boolean;
	readonly railWidth: number;
	readonly inspectorOpen: boolean;
	readonly inspectorWidth: number;
}

export const DEFAULT_LAYOUT: Layout = {
	railOpen: true,
	railWidth: 268,
	inspectorOpen: true,
	inspectorWidth: 360,
};

export const RAIL_LIMITS = [200, 460] as const;
export const INSPECTOR_LIMITS = [300, 620] as const;

/** Storage key carries its version: a stale shape is discarded, never half-applied. */
export const LAYOUT_KEY = "gentle-shell:ui-layout:v1";

export function clampWidth(width: number, [min, max]: readonly [number, number]): number {
	if (!Number.isFinite(width)) return min;
	return Math.min(max, Math.max(min, Math.round(width)));
}

/**
 * Read a stored layout.
 *
 * Anything unreadable, partial or out of range falls back per field to the default, because a broken
 * value here would leave the user with a panel they cannot see or resize back.
 */
export function parseLayout(raw: string | null): Layout {
	if (raw === null) return DEFAULT_LAYOUT;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return DEFAULT_LAYOUT;
	}
	if (typeof value !== "object" || value === null) return DEFAULT_LAYOUT;

	const record = value as Partial<Record<keyof Layout, unknown>>;
	return {
		railOpen: typeof record.railOpen === "boolean" ? record.railOpen : DEFAULT_LAYOUT.railOpen,
		railWidth: clampWidth(typeof record.railWidth === "number" ? record.railWidth : DEFAULT_LAYOUT.railWidth, RAIL_LIMITS),
		inspectorOpen:
			typeof record.inspectorOpen === "boolean" ? record.inspectorOpen : DEFAULT_LAYOUT.inspectorOpen,
		inspectorWidth: clampWidth(
			typeof record.inspectorWidth === "number" ? record.inspectorWidth : DEFAULT_LAYOUT.inspectorWidth,
			INSPECTOR_LIMITS,
		),
	};
}

export function serializeLayout(layout: Layout): string {
	return JSON.stringify(layout);
}

/** Width of a divider. Small enough to disappear, wide enough to grab. */
export const SPLITTER_WIDTH = 6;

/** Below these widths the conversation needs the room more than the panels do. */
export const RAIL_BREAKPOINT = 820;
export const INSPECTOR_BREAKPOINT = 660;

/** The conversation never gets less than this; panels give way before it does. */
export const MIN_CONTENT = 380;

/**
 * The grid columns for a layout: rail, divider, content, divider, inspector.
 *
 * A closed panel collapses to zero together with its divider, so nothing has to be removed from the
 * DOM and the toggles keep working while the panel is hidden. `resolveLayout` has already made sure
 * the numbers leave room for the conversation.
 */
export function gridTemplate(layout: Layout): string {
	const rail = layout.railOpen ? `${layout.railWidth}px ${SPLITTER_WIDTH}px` : "0px 0px";
	const inspector = layout.inspectorOpen ? `${SPLITTER_WIDTH}px ${layout.inspectorWidth}px` : "0px 0px";
	return `${rail} minmax(0, 1fr) ${inspector}`;
}

/**
 * What a layout means at a given window width.
 *
 * The saved preference stays the user's: a narrow window hides the panels because the conversation
 * needs the room, and widening it again brings them back exactly as they were arranged.
 */
export function resolveLayout(layout: Layout, width: number): Layout {
	if (!Number.isFinite(width) || width <= 0) return layout;

	let railOpen = layout.railOpen && width >= RAIL_BREAKPOINT;
	let inspectorOpen = layout.inspectorOpen && width >= INSPECTOR_BREAKPOINT;
	let railWidth = layout.railWidth;
	let inspectorWidth = layout.inspectorWidth;

	const content = (): number =>
		width - (railOpen ? railWidth + SPLITTER_WIDTH : 0) - (inspectorOpen ? inspectorWidth + SPLITTER_WIDTH : 0);

	// Two open panels at their preferred width can leave the conversation 260px on a 900px window.
	// The inspector gives way first because the rail is the map of the work, and both stop at their
	// minimum before anything is closed.
	if (content() < MIN_CONTENT && inspectorOpen) {
		const cut = Math.min(MIN_CONTENT - content(), Math.max(0, inspectorWidth - INSPECTOR_LIMITS[0]));
		inspectorWidth -= cut;
	}
	if (content() < MIN_CONTENT && railOpen) {
		const cut = Math.min(MIN_CONTENT - content(), Math.max(0, railWidth - RAIL_LIMITS[0]));
		railWidth -= cut;
	}
	// Still cramped: drop panels rather than show a conversation two words wide.
	if (content() < MIN_CONTENT && inspectorOpen) inspectorOpen = false;
	if (content() < MIN_CONTENT && railOpen) railOpen = false;

	return { ...layout, railOpen, inspectorOpen, railWidth, inspectorWidth };
}
