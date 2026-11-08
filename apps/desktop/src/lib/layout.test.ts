import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_LAYOUT,
	INSPECTOR_BREAKPOINT,
	MIN_CONTENT,
	RAIL_BREAKPOINT,
	resolveLayout,
	INSPECTOR_LIMITS,
	RAIL_LIMITS,
	clampWidth,
	gridTemplate,
	parseLayout,
	serializeLayout,
} from "./layout.ts";

test("an absent layout is the default", () => {
	assert.deepEqual(parseLayout(null), DEFAULT_LAYOUT);
});

test("a stored layout round-trips", () => {
	const layout = { railOpen: false, railWidth: 320, inspectorOpen: true, inspectorWidth: 420 };
	assert.deepEqual(parseLayout(serializeLayout(layout)), layout);
});

test("garbage falls back instead of breaking the shell", () => {
	assert.deepEqual(parseLayout("{not json"), DEFAULT_LAYOUT);
	assert.deepEqual(parseLayout("42"), DEFAULT_LAYOUT);
	assert.deepEqual(parseLayout("null"), DEFAULT_LAYOUT);
});

test("each field is validated on its own", () => {
	const parsed = parseLayout(JSON.stringify({ railOpen: "yes", railWidth: 9999, inspectorOpen: true }));
	assert.equal(parsed.railOpen, DEFAULT_LAYOUT.railOpen);
	assert.equal(parsed.railWidth, RAIL_LIMITS[1]);
	assert.equal(parsed.inspectorOpen, true);
	assert.equal(parsed.inspectorWidth, DEFAULT_LAYOUT.inspectorWidth);
});

test("widths are clamped and rounded inside their limits", () => {
	assert.equal(clampWidth(10, RAIL_LIMITS), RAIL_LIMITS[0]);
	assert.equal(clampWidth(10_000, INSPECTOR_LIMITS), INSPECTOR_LIMITS[1]);
	assert.equal(clampWidth(311.6, RAIL_LIMITS), 312);
	assert.equal(clampWidth(Number.NaN, RAIL_LIMITS), RAIL_LIMITS[0]);
});

test("grid columns collapse a closed panel to zero", () => {
	assert.equal(gridTemplate(DEFAULT_LAYOUT), "268px 6px minmax(0, 1fr) 6px 360px");
	assert.equal(
		gridTemplate({ ...DEFAULT_LAYOUT, railOpen: false, inspectorOpen: false }),
		"0px 0px minmax(0, 1fr) 0px 0px",
	);
});

test("a narrow window hides the panels without forgetting them", () => {
	const wide = resolveLayout(DEFAULT_LAYOUT, 1480);
	assert.deepEqual(wide, DEFAULT_LAYOUT);

	const medium = resolveLayout(DEFAULT_LAYOUT, RAIL_BREAKPOINT - 40);
	assert.equal(medium.railOpen, false);
	assert.equal(medium.inspectorOpen, true);

	const narrow = resolveLayout(DEFAULT_LAYOUT, INSPECTOR_BREAKPOINT - 40);
	assert.equal(narrow.railOpen, false);
	assert.equal(narrow.inspectorOpen, false);
	// The saved width survives, so widening the window restores the arrangement.
	assert.equal(narrow.railWidth, DEFAULT_LAYOUT.railWidth);
	assert.equal(narrow.inspectorWidth, DEFAULT_LAYOUT.inspectorWidth);
});

test("a closed panel stays closed on a wide window", () => {
	const resolved = resolveLayout({ ...DEFAULT_LAYOUT, railOpen: false }, 1480);
	assert.equal(resolved.railOpen, false);
});

test("two open panels give room back to the conversation", () => {
	// 900 - 268 - 6 - 360 - 6 leaves 260 for the chat, which is unusable.
	const resolved = resolveLayout(DEFAULT_LAYOUT, 900);
	const content = 900 - (resolved.railWidth + 6) - (resolved.inspectorWidth + 6);
	assert.equal(resolved.railOpen, true);
	assert.equal(resolved.inspectorOpen, true);
	assert.ok(content >= MIN_CONTENT, `content was ${content}`);
	assert.equal(resolved.inspectorWidth, INSPECTOR_LIMITS[0], "the inspector gives way first, down to its minimum");
	assert.ok(resolved.railWidth < DEFAULT_LAYOUT.railWidth, "then the rail shrinks too, but only after it");
	assert.ok(resolved.railWidth >= RAIL_LIMITS[0]);
});
