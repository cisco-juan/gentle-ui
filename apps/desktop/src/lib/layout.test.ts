import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_LAYOUT,
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
