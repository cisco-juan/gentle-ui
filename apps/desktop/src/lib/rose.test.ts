import assert from "node:assert/strict";
import test from "node:test";
import {
	BANNER_PALETTES,
	DEFAULT_BANNER_CONFIG,
	ROSE_LARGE,
	TEXT_LOGO,
	artWidth,
	flashPhase,
	loadRoseSettings,
	parseAnimationPolicy,
	parseBannerConfig,
	roseCellRgb,
	roseOpacity,
	rosePlan,
	shimmer,
	sideBySideMinWidth,
	tickCadence,
} from "./rose.ts";

test("the rose is the harness's own art, not a drawing of it", () => {
	// 17 lines is what `ROSE_LARGE_RAW` holds in gentle-pi's `extensions/startup-banner.ts`.
	assert.equal(ROSE_LARGE.length, 17);
	assert.equal(ROSE_LARGE[0].trim(), "⣠⣾⣷⣶⣦⣤⣤⣄⣠⣄⣀  ⢀⣀⣀");
	assert.equal(ROSE_LARGE[ROSE_LARGE.length - 1]?.trim(), "⠐⠈");
	for (const line of ROSE_LARGE) {
		assert.ok(line.trim().length > 0, "no blank line in the art");
		assert.equal(line, line.trimEnd(), "trailing whitespace would shift the art");
		assert.ok(!line.includes("\t"), "a tab is not a cell");
	}
	// Braille patterns are single-width, so a line's length is its width in cells.
	assert.equal(new Set(ROSE_LARGE.map((line) => [...line].length > 0)).size, 1);
	assert.ok(TEXT_LOGO.length > 0);
	assert.equal(TEXT_LOGO[0], TEXT_LOGO[0].trimEnd());
});

test("the rose fades in over ten ticks and then stays lit", () => {
	assert.equal(roseOpacity(0), 0);
	assert.equal(roseOpacity(5), 0.5);
	assert.equal(roseOpacity(10), 1);
	assert.equal(roseOpacity(20), 1);
});

test("the white flash follows the fade and decays over twelve ticks", () => {
	assert.equal(flashPhase(9), 0);
	assert.equal(flashPhase(10), 1);
	assert.ok(flashPhase(16) > 0 && flashPhase(16) < 1);
	assert.equal(flashPhase(22), 0);
	assert.equal(flashPhase(40), 0);
});

test("the shimmer stays inside the tenth of brightness the terminal allows it", () => {
	for (const tick of [0, 1, 7, 40, 999]) {
		for (let x = 0; x < 40; x++) {
			for (let y = 0; y < 17; y++) {
				const pulse = shimmer(x, y, tick);
				assert.ok(pulse >= 0.9 - 0.1 - 1e-9 && pulse <= 0.9 + 0.1 + 1e-9, `pulse ${pulse} at ${x},${y}`);
			}
		}
	}
	// Same cell, one frame later: the wave has moved.
	assert.notEqual(shimmer(4, 4, 0), shimmer(4, 4, 8));
});

test("a cell is the palette colour, white at the flash, and never black", () => {
	const pink = BANNER_PALETTES.pink.rose;
	// Tick 0 is the harness's `Math.max(0.01, …)` floor: almost black, not black, so the art is already there.
	assert.deepEqual(roseCellRgb(0, 3, 4, BANNER_PALETTES.pink), [2, 1, 1]);
	const lit = roseCellRgb(20, 3, 4, BANNER_PALETTES.pink);
	assert.ok(lit[0] > 0 && lit[1] > 0 && lit[2] > 0);
	assert.ok(lit[2] > pink[2] * 0.6);
	assert.deepEqual(roseCellRgb(10, 3, 4, BANNER_PALETTES.pink), [255, 255, 255]);
});

test("each animation policy has the cadence the terminal gives it", () => {
	assert.deepEqual(tickCadence("quality"), { intervalMs: 25, ticksPerInterval: 1 });
	assert.deepEqual(tickCadence("performance"), { intervalMs: 250, ticksPerInterval: 10 });
	assert.equal(tickCadence("potato"), null);
});

test("a missing, malformed or partial banner file falls back field by field", () => {
	assert.deepEqual(parseBannerConfig(null), DEFAULT_BANNER_CONFIG);
	assert.deepEqual(parseBannerConfig(""), DEFAULT_BANNER_CONFIG);
	assert.deepEqual(parseBannerConfig("{oops"), DEFAULT_BANNER_CONFIG);
	assert.deepEqual(parseBannerConfig("[]"), DEFAULT_BANNER_CONFIG);
	assert.deepEqual(parseBannerConfig('{"showRose":false}'), { showRose: false, showTextLogo: true, color: "pink" });
	assert.deepEqual(parseBannerConfig('{"color":"cyan"}'), { showRose: true, showTextLogo: true, color: "cyan" });
	assert.deepEqual(parseBannerConfig('{"color":"chartreuse","showTextLogo":"yes"}'), DEFAULT_BANNER_CONFIG);
});

test("a missing or malformed animations file resolves to quality", () => {
	assert.equal(parseAnimationPolicy(null), "quality");
	assert.equal(parseAnimationPolicy("nope"), "quality");
	assert.equal(parseAnimationPolicy('{"schema":"gentle-pi.animations/v1","policy":"potato"}'), "potato");
	assert.equal(parseAnimationPolicy('{"schema":"gentle-pi.animations/v1","policy":"performance"}'), "performance");
	assert.equal(parseAnimationPolicy('{"schema":"other/v1","policy":"potato"}'), "quality");
	assert.equal(parseAnimationPolicy('{"policy":"potato"}'), "quality");
});

test("both files are read once, and a reader that fails leaves the defaults standing", async () => {
	const reads: string[] = [];
	const settings = await loadRoseSettings(async (file) => {
		reads.push(file);
		if (file === "banner.json") return '{"showRose":false,"color":"green"}';
		return null;
	});
	assert.deepEqual(reads.sort(), ["animations.json", "banner.json"]);
	assert.deepEqual(settings, { banner: { showRose: false, showTextLogo: true, color: "green" }, policy: "quality" });

	const broken = await loadRoseSettings(async () => {
		throw new Error("unreadable");
	});
	assert.deepEqual(broken, { banner: DEFAULT_BANNER_CONFIG, policy: "quality" });
});

test("the rose and the text logo sit side by side only when the width is there", () => {
	const min = sideBySideMinWidth();
	assert.ok(min > 0);
	assert.deepEqual(rosePlan(min, DEFAULT_BANNER_CONFIG), { arrangement: "horizontal", logoArt: true, roseArt: true });

	// Not enough for both on a line: stacked, with the wordmark still drawn above the rose.
	const stacked = rosePlan(min - 1, DEFAULT_BANNER_CONFIG);
	assert.equal(stacked.arrangement, "stacked");
	assert.equal(stacked.roseArt, true);
	assert.equal(stacked.logoArt, true);

	// Narrower still, the wordmark is left out rather than clipped; the rose is what has to survive.
	const narrow = rosePlan(artWidth(ROSE_LARGE) + 2, DEFAULT_BANNER_CONFIG);
	assert.equal(narrow.arrangement, "stacked");
	assert.equal(narrow.roseArt, true);
	assert.equal(narrow.logoArt, false);

	assert.equal(rosePlan(10, { showRose: true, showTextLogo: false, color: "pink" }).arrangement, "rose");
	assert.equal(rosePlan(10, { showRose: true, showTextLogo: false, color: "pink" }).roseArt, false);
	assert.equal(rosePlan(10, { showRose: false, showTextLogo: true, color: "pink" }).arrangement, "logo");
	assert.deepEqual(rosePlan(min, { showRose: false, showTextLogo: false, color: "pink" }), {
		arrangement: "none",
		logoArt: false,
		roseArt: false,
	});
});
