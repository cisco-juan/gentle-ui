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

/**
 * The grid columns for a layout: rail, divider, content, divider, inspector.
 *
 * A closed panel collapses to zero together with its divider, so nothing has to be removed from the
 * DOM and the toggles keep working while the panel is hidden.
 */
export function gridTemplate(layout: Layout): string {
	const rail = layout.railOpen ? `${layout.railWidth}px ${SPLITTER_WIDTH}px` : "0px 0px";
	const inspector = layout.inspectorOpen ? `${SPLITTER_WIDTH}px ${layout.inspectorWidth}px` : "0px 0px";
	return `${rail} minmax(0, 1fr) ${inspector}`;
}
