/**
 * The Gentle Shell rose, ported from the harness's own startup banner.
 *
 * The art, the palette, the fade, the flash and the shimmer are not a likeness of the terminal's
 * banner: they are the banner. `extensions/startup-banner.ts` in gentle-pi draws the same 17 lines of
 * Braille, with the same maths, and this module keeps them in one place so the renderer only has to
 * paint cells. Everything here is pure — a function of the tick, the cell and the config — which is
 * what makes it testable without a window.
 */

/** `ROSE_LARGE_RAW` from gentle-pi, character for character. */
export const ROSE_LARGE: readonly string[] = [
	"             ⣠⣾⣷⣶⣦⣤⣤⣄⣠⣄⣀  ⢀⣀⣀",
	"          ⢀⣴⣿⣿⠿⣋⣭⣭⣯⣭⣍⣭⣿⣟⠛⠛⠿⣿⣷⣄",
	"      ⢀⣴⣾⡟⢻⣿⡟⠁⣼⣿⠏⣵⢻⣿⣻⣿⣿⢿⡻⣿⣿⣶⡌⢿⣿⣷⣦⣤⡄",
	"   ⣤⣶⣾⣿⣿⠏ ⠈⢿⣄ ⢹⣏⠠⠟⣾⣿⣿⣿⣿⣿⠷⣏⣼⠟⢡⣿⡟⠋⢻⣿⣿⡄",
	"   ⠈⣿⣿⣿⣿⡆   ⣽⢧⡘⠈⠳⣦⣍⠛⠛⢦⣉⣴⣛⣫⣭⣴⡟⠋  ⣾⣿⣿⡿",
	"   ⢀⠹⣿⣿⣿⣷⣤⡄ ⠋ ⠙⢆ ⣠⠴⠟⠛⣛⣛⣛⠟⠋⠁⠺⡇ ⣀⣴⣿⣿⡟⠁",
	"   ⠈⣀⠈⠛⠷⠿⣿⣿⣷⣤⣀ ⢠⠋   ⠈⠉⠉    ⣠⣴⣥⠾⠛⠉⣰⣿⣷",
	"          ⠹⣯⣝⠛⠛⠷⢶⣤⣤⣀   ⢀⡠⠖⠋⠉⢉⣀⣀⣴⣾⣿⠿⠟⠃",
	"             ⠘⠻⢿⣦⣄⡀  ⠉⠛⢦⠠⢊⠤⠴⢒⣛⣛⣩⣽⡿⠟⠁",
	"        ⠶⢶⣤⣄⡀⠨⠭⠽⠟⣓⢦⣀⠈⢇⡥⠖⠛⠋⠉⠉",
	"           ⠈⢷ ⠐⠂⢤⣽⣄ ⠰⡎⠙⠳⣄⡀ ⠈⢣⠘⢦⠋",
	"            ⠈⢳⣀⡒⠉⠉⣉⠙⡲⣽⣄ ⣏⠳⡄ ⠘⡇ ⡾⠁",
	"              ⠛⠻⢦⣄⣉⡁⣀⣀⣈⣙⣺⣌⡇⢠⢀⡇⡾",
	"                   ⠈⠉    ⠈⠳⡄⣸⢱⠇",
	"                           ⡷⠡⡯⢖⠉",
	"                        ⢀⡴⢪⠔⣉⠔⠋",
	"                           ⠐⠈",
];

/** `TEXT_LOGO` from gentle-pi: the script wordmark the terminal draws beside the rose. */
export const TEXT_LOGO: readonly string[] = [
	"                  ▄▄▄▀▀▀▀▀██                                ▄▄▀▄▄          ▄▄█▀▀▀██   ▄▄▀██               ▄▄▀▄▄   ▄▄▀▄▄",
	"              ▄▄█▀▀▒▒▒▒▒▄▄█▀▒                   ▄██     ▄▄█▀█▄█▀▒▒       ▄█▀▀▒▒▒▄█▀▒ ▄██▄█▀▒           ▄▄█▀█▄█▀▄▄█▀█▄█▀▒",
	"          ▄▄██▀▒▒▒▒▒▄▄▄▀▀▒▒▒▒        ▄▄▄  ▀▀▀▀██▀▀▀▀▀███▀█▄▀▀▒▒▒▒      ██▄▄▒▒▒▒▒▒▒ ▄██▀▀▒▒▒          ▄██▀█▄▀▀▄██▀█▄▀▀▒▒▒",
	"        ▄██▀▒▒▒▒     ▒▒▄▄█ ▄▄▄▀██ ▄▄▄▀▀▀▄  ▄██▀▒▒▒▒▄██▀▀▀▒▄▄███         ▀▀▀██▄▄  ▄██▀▒▄▄▀██   ▄▄▀▀██ ██▀▀▀▒▒▒██▀▀▀▒▒▒",
	"       ██▀▒▒▒     ▄▄▄███▀▄██▀▀▀▄▄██▀▀▄█▀▄▄██▀▒▒▒▄▄██▀▒▒▄██▀▀▀▄▄      ▄▄     ▀██▄▄██▀▄██▀██▒  ▄██▄▄▀▒ █▀▒▒▒   █▀▒▒▒",
	"       ▀█▄▄▄▄▄▀▀▀█▄▄███▄▒▀▀▀▀▀▀▒▀▀▒▒▀▀▀▀▒██▄▄▀▀▀ ▀█▄▀▀▀ ▀▀▀▀▀▒▒      ▀█▄▄▄▄█▀▀▒▒▀▀▒▒▀▀▒ ██▄▄▀▀█▄▄▄▄▀▀█▄▄▀▀▀▄▄▀█▄▄▀▀▀",
	"        ▒▄▄▄█▀▀▀█▄█▀▀▒▒▒▒ ▒▒▒▒▒▒ ▒▒  ▒▒▒▒ ▒▒▒▒▒▒▒ ▒▒▒▒▒▒ ▒▒▒▒▒        ▒▀▀▀▀▒▒▒▒  ▒▒▒▒▒▒ ▒▒▒▒▒ ▒▒▒▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒",
	"     ▄▄▀▀ ▒▒▒▒▄██▀▒▒▒▒",
	"   ▄█ ▒▒▒▄▄██▀▀▒▒▒▒",
	"    ▀▀▀▀▀▀▒▒▒▒▒▒",
	"     ▒▒▒▒▒▒",
];

export type Rgb = readonly [number, number, number];

export type BannerColor = "pink" | "cyan" | "yellow" | "green";

export const BANNER_COLORS: readonly BannerColor[] = ["pink", "cyan", "yellow", "green"];

export interface BannerConfig {
	readonly showRose: boolean;
	readonly showTextLogo: boolean;
	readonly color: BannerColor;
}

/** `banner.json` absent, unreadable or partial resolves to this, exactly as the terminal does. */
export const DEFAULT_BANNER_CONFIG: BannerConfig = { showRose: true, showTextLogo: true, color: "pink" };

/** The two entries of a palette this UI paints. */
export interface RosePalette {
	readonly rose: Rgb;
	readonly logoFresh: Rgb;
}

export const BANNER_PALETTES: Record<BannerColor, RosePalette> = {
	pink: { rose: [255, 118, 195], logoFresh: [255, 138, 206] },
	cyan: { rose: [95, 210, 255], logoFresh: [105, 220, 255] },
	yellow: { rose: [255, 210, 95], logoFresh: [255, 215, 105] },
	green: { rose: [110, 220, 145], logoFresh: [120, 230, 150] },
};

/** `animation-policy.ts` in gentle-pi: how many ticks a second the banner is allowed to spend. */
export type AnimationPolicy = "quality" | "performance" | "potato";

export const DEFAULT_ANIMATION_POLICY: AnimationPolicy = "quality";

export const ANIMATION_SCHEMA = "gentle-pi.animations/v1";

/** The two files this reads, in the order the terminal reads them. */
export type RoseConfigFile = "banner.json" | "animations.json";

export interface RoseSettings {
	readonly banner: BannerConfig;
	readonly policy: AnimationPolicy;
}

export const DEFAULT_ROSE_SETTINGS: RoseSettings = {
	banner: DEFAULT_BANNER_CONFIG,
	policy: DEFAULT_ANIMATION_POLICY,
};

/** Ticks the rose takes to reach full brightness, and the flash that follows it. */
const FADE_TICKS = 10;
const FLASH_START_TICK = 10;
const FLASH_TICKS = 12;

/** The rose is dimmer than it looks: a tenth either side of nine tenths, forever. */
const PULSE_BASE = 0.9;
const PULSE_SWING = 0.1;
const PULSE_RATE = 0.08;

/** How far into the fade-in a tick is, as a fraction. */
export function roseOpacity(tick: number): number {
	return Math.min(1, tick / FADE_TICKS);
}

/** The white flash after the fade: full at the start tick, gone `FLASH_TICKS` later. */
export function flashPhase(tick: number): number {
	return tick >= FLASH_START_TICK ? Math.max(0, 1 - (tick - FLASH_START_TICK) / FLASH_TICKS) : 0;
}

/**
 * The perpetual shimmer: a diagonal wave, a frame being two ticks.
 *
 * It returns a multiplier, not a colour, so the same wave lights the rose and any other cell the
 * renderer wants to breathe with it.
 */
export function shimmer(x: number, y: number, tick: number): number {
	const frame = Math.floor(tick / 2);
	return PULSE_BASE + Math.sin((x + y + frame) * PULSE_RATE) * PULSE_SWING;
}

/**
 * One rose cell at one tick, as RGB.
 *
 * The order matters and is the terminal's: the shimmer darkens the palette colour, then the flash
 * mixes it towards white, and past 85% of the flash the cell is simply white. The `0.01` floor keeps a
 * cell at tick 0 from vanishing into the background before the fade starts.
 */
export function roseCellRgb(tick: number, x: number, y: number, palette: RosePalette): Rgb {
	const k = Math.max(0.01, roseOpacity(tick) * shimmer(x, y, tick));
	const f = flashPhase(tick) ** 0.4;
	if (f > 0.85) return [255, 255, 255];
	const mix = (channel: number): number => Math.floor(channel + (255 - channel) * f);
	return [mix(Math.floor(palette.rose[0] * k)), mix(Math.floor(palette.rose[1] * k)), mix(Math.floor(palette.rose[2] * k))];
}

export interface TickCadence {
	readonly intervalMs: number;
	/** Ticks advanced per interval: the performance policy skips, it does not slow down. */
	readonly ticksPerInterval: number;
}

/**
 * The cadence a policy allows, or `null` for `potato`.
 *
 * `null` is the whole point of the policy: the banner is drawn once, at its final frame, and nothing
 * is scheduled.
 */
export function tickCadence(policy: AnimationPolicy): TickCadence | null {
	if (policy === "potato") return null;
	return policy === "performance" ? { intervalMs: 250, ticksPerInterval: 10 } : { intervalMs: 25, ticksPerInterval: 1 };
}

function parseJson(raw: string | null | undefined): unknown {
	if (typeof raw !== "string" || raw.trim().length === 0) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `banner.json` as the terminal reads it.
 *
 * Absent, unreadable, malformed and partial are all the same kind of failure here — a banner is
 * decoration, so a broken file is not worth a message — and each field falls back on its own, which is
 * what lets `{"showRose":false}` mean "no rose" rather than "no config".
 */
export function parseBannerConfig(raw: string | null | undefined): BannerConfig {
	const value = parseJson(raw);
	if (!isRecord(value)) return DEFAULT_BANNER_CONFIG;
	return {
		showRose: typeof value.showRose === "boolean" ? value.showRose : DEFAULT_BANNER_CONFIG.showRose,
		showTextLogo: typeof value.showTextLogo === "boolean" ? value.showTextLogo : DEFAULT_BANNER_CONFIG.showTextLogo,
		color: BANNER_COLORS.includes(value.color as BannerColor) ? (value.color as BannerColor) : DEFAULT_BANNER_CONFIG.color,
	};
}

/** `animations.json`, with gentle-pi's strictness: the schema is part of the format, not a comment. */
export function parseAnimationPolicy(raw: string | null | undefined): AnimationPolicy {
	const value = parseJson(raw);
	if (!isRecord(value)) return DEFAULT_ANIMATION_POLICY;
	if (value.schema !== ANIMATION_SCHEMA || Object.keys(value).length !== 2) return DEFAULT_ANIMATION_POLICY;
	const policy = value.policy;
	return policy === "quality" || policy === "performance" || policy === "potato" ? policy : DEFAULT_ANIMATION_POLICY;
}

/**
 * Read both files once, through a reader the caller supplies.
 *
 * The reader is injected because the files live in the harness's config home, not in the webview: the
 * one thing this module must not do is guess where they are. A reader that throws, or answers `null`,
 * is a missing file — the defaults apply silently.
 */
export async function loadRoseSettings(read: (file: RoseConfigFile) => Promise<string | null>): Promise<RoseSettings> {
	const [banner, animations] = await Promise.all([
		read("banner.json").catch(() => null),
		read("animations.json").catch(() => null),
	]);
	return { banner: parseBannerConfig(banner), policy: parseAnimationPolicy(animations) };
}

/** Width of an art block in terminal cells. */
export function artWidth(lines: readonly string[]): number {
	return lines.reduce((widest, line) => Math.max(widest, [...line].length), 0);
}

/** The width the terminal needs before it draws the rose and the wordmark on one line. */
export function sideBySideMinWidth(): number {
	return artWidth(ROSE_LARGE) + 3 + artWidth(TEXT_LOGO) + 4;
}

/** How the banner is drawn at a given width in cells. */
export type RoseArrangement = "horizontal" | "stacked" | "rose" | "logo" | "none";

export interface RosePlan {
	readonly arrangement: RoseArrangement;
	/** The script wordmark fits, so it is drawn as art; otherwise the one-line wordmark stands in. */
	readonly logoArt: boolean;
	/** The rose art fits, so it is drawn; otherwise it is left out rather than clipped. */
	readonly roseArt: boolean;
}

/**
 * The terminal's own width rule: side by side when there is room, stacked when there is not, and
 * nothing at all when the config asks for neither. Each block is only drawn when it fits, which is
 * what keeps a narrow window from clipping the art instead of shrinking what it shows.
 */
export function rosePlan(cells: number, config: BannerConfig): RosePlan {
	const roseFits = cells >= artWidth(ROSE_LARGE) + 2;
	const logoFits = cells >= artWidth(TEXT_LOGO) + 2;
	if (!config.showRose && !config.showTextLogo) return { arrangement: "none", logoArt: false, roseArt: false };
	if (!config.showRose) return { arrangement: "logo", logoArt: logoFits, roseArt: false };
	if (!config.showTextLogo) return { arrangement: "rose", logoArt: false, roseArt: roseFits };
	if (cells >= sideBySideMinWidth()) return { arrangement: "horizontal", logoArt: true, roseArt: true };
	return { arrangement: "stacked", logoArt: logoFits, roseArt: roseFits };
}
