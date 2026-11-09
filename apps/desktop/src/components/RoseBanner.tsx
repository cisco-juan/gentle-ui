import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import {
	BANNER_PALETTES,
	DEFAULT_ROSE_SETTINGS,
	ROSE_LARGE,
	TEXT_LOGO,
	roseCellRgb,
	roseOpacity,
	rosePlan,
	tickCadence,
	type RoseSettings,
	type Rgb,
} from "../lib/rose";

/**
 * The Gentle Shell rose, drawn at the start of a chat the way the terminal draws it.
 *
 * It is decoration, so it is `aria-hidden` and it never moves the layout: the art is in the DOM at full
 * size from the first frame and only its colour changes, which is what makes the fade read as a fade
 * instead of the transcript jumping when it lands. The animation follows the policy in
 * `animations.json` — `potato` draws the finished banner once and schedules nothing — and it is torn
 * down with the component, so an open conversation never keeps a timer alive.
 *
 * The config comes from the harness's own `banner.json` and `animations.json` through
 * `loadRoseSettings`; the app has no file access of its own, so today it renders the documented
 * defaults, and a read that fails silently does the same.
 */
export function RoseBanner(props: { settings?: Accessor<RoseSettings> }) {
	const settings = (): RoseSettings => props.settings?.() ?? DEFAULT_ROSE_SETTINGS;
	const [tick, setTick] = createSignal(0);
	const [cells, setCells] = createSignal(0);
	let host: HTMLDivElement | undefined;

	createEffect(() => {
		const cadence = tickCadence(settings().policy);
		setTick(0);
		if (cadence === null) {
			// `potato`: the finished banner, drawn once, with nothing scheduled behind it.
			setTick(FINAL_TICK);
			return;
		}
		const timer = setInterval(() => setTick((current) => current + cadence.ticksPerInterval), cadence.intervalMs);
		onCleanup(() => clearInterval(timer));
	});

	onMount(() => {
		if (!host) return;
		const measure = (width: number): void => {
			setCells(Math.max(0, Math.floor(width / CELL_PX)));
		};
		measure(host.clientWidth);
		const observer = new ResizeObserver((entries) => {
			const entry = entries[entries.length - 1];
			if (entry) measure(entry.contentRect.width);
		});
		observer.observe(host);
		onCleanup(() => observer.disconnect());
	});

	const plan = createMemo(() => rosePlan(cells(), settings().banner));
	const palette = () => BANNER_PALETTES[settings().banner.color];
	const roseCell = (x: number, y: number): string => css(roseCellRgb(tick(), x, y, palette()));
	const logoCell = (): string => css(faded(palette().logoFresh, Math.max(0.06, roseOpacity(tick()))));

	return (
		<div
			class="rose-banner"
			classList={{ horizontal: plan().arrangement === "horizontal" }}
			aria-hidden="true"
			ref={host}
		>
			{/* Stacked, the terminal draws the wordmark above the rose; side by side, the rose leads. */}
			<Show when={settings().banner.showRose && plan().roseArt}>
				<Art lines={ROSE_LARGE} paint={roseCell} />
			</Show>
			<Show when={settings().banner.showTextLogo && plan().logoArt}>
				<Art lines={TEXT_LOGO} paint={logoCell} />
			</Show>
			<Show when={settings().banner.showTextLogo && !plan().logoArt}>
				<span class="rose-wordmark">✿ Gentle UI ✿</span>
			</Show>
		</div>
	);
}

/** A finished banner: past the flash, fully lit, with the shimmer still inside its band. */
const FINAL_TICK = 30;

/**
 * Advance of one cell of the art, in pixels.
 *
 * The art is drawn in a 12px monospace face, whose advance is 0.6em; the width rule is about how many
 * cells fit, so the panel's pixel width is converted with this. Being a pixel off only ever moves the
 * banner one arrangement step, never its meaning.
 */
const CELL_PX = 7.2;

/** One block of art: a `<pre>` of rows, each cell painted by the caller. */
function Art(props: { lines: readonly string[]; paint: (x: number, y: number) => string }) {
	// Built once per art: the cells keep their identity, so a tick repaints colours and never rows.
	const rows = createMemo(() => props.lines.map((line, y) => [...line].map((char, x) => ({ char, x, y }))));

	return (
		<pre class="rose-art">
			<For each={rows()}>
				{(row) => (
					<div class="rose-line">
						<For each={row}>
							{(cell) => (cell.char === " " ? " " : <span style={{ color: props.paint(cell.x, cell.y) }}>{cell.char}</span>)}
						</For>
					</div>
				)}
			</For>
		</pre>
	);
}

function css(rgb: Rgb): string {
	return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
}

function faded(rgb: Rgb, opacity: number): Rgb {
	return [Math.floor(rgb[0] * opacity), Math.floor(rgb[1] * opacity), Math.floor(rgb[2] * opacity)];
}
