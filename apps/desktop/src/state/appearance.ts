import { createSignal, type Accessor } from "solid-js";
import type { AppearanceView, ThemeCatalogEntry, ResolvedTheme } from "@gentle-shell/protocol";
import type { BridgeClient } from "../lib/bridge";
import { applyCssVariables, cssVariablesOf, namesToResolve, themeNameFor, type StyleSink } from "../lib/appearance";
import { DEFAULT_ROSE_SETTINGS, loadRoseSettings, type RoseConfigFile, type RoseSettings } from "../lib/rose";

/**
 * The selected theme, painted on the app root, and the rose's own configuration.
 *
 * The bridge answers what Pi's settings select and what this machine has; this panel turns the resolved
 * tokens into the app's CSS variables and repaints when the OS colour scheme changes, because `system`
 * means `dark` or `light` here and only the desktop can know which. A theme that cannot be resolved — a
 * name the machine no longer has, or a bridge that is not connected — paints nothing, which puts the app's
 * own defaults back rather than leaving the previous theme's colours behind.
 *
 * The rose's two files arrive as text and are parsed by `rose.ts`, the module that already holds the
 * harness's rules for them; a missing or broken file means the documented defaults, as in the terminal.
 */
export interface AppearancePanelView {
	readonly data: AppearanceView | null;
	readonly busy: boolean;
	readonly error: string | null;
}

export interface AppearancePanelOptions {
	readonly connect: () => BridgeClient | null;
	/** The style object the variables are painted on; a test passes a stand-in instead of a document. */
	readonly style?: StyleSink;
	/** Whether the OS asks for a dark scheme, which is what `system` follows. */
	readonly prefersDark?: () => boolean;
}

export interface AppearancePanel {
	readonly view: Accessor<AppearancePanelView>;
	/** The theme Pi's settings select, as the bridge last reported it. */
	readonly current: Accessor<string | null>;
	readonly available: Accessor<readonly ThemeCatalogEntry[]>;
	readonly rose: Accessor<RoseSettings>;
	refresh(): Promise<void>;
	/** Choose a theme. A refusal from the bridge is reported, never shown as applied. */
	select(name: string): Promise<void>;
	stop(): void;
}

export function createAppearancePanel(options: AppearancePanelOptions): AppearancePanel {
	const [view, setView] = createSignal<AppearancePanelView>({ data: null, busy: false, error: null });
	const [rose, setRose] = createSignal<RoseSettings>(DEFAULT_ROSE_SETTINGS);
	const prefersDark = options.prefersDark ?? (() => window.matchMedia("(prefers-color-scheme: dark)").matches);
	const style = (): StyleSink => options.style ?? document.documentElement.style;

	/** The tokens of each name the current selection needs; `system` needs both of Pi's built-ins. */
	let tokens = new Map<string, ResolvedTheme | null>();
	/** The variables this panel set, which are exactly the ones it has to remove again. */
	let painted: readonly string[] = [];

	const current = (): string | null => view().data?.theme.current ?? null;
	const available = (): readonly ThemeCatalogEntry[] => view().data?.theme.available ?? [];

	function paint(): void {
		const name = themeNameFor(current(), prefersDark());
		painted = applyCssVariables(style(), cssVariablesOf(name === null ? null : (tokens.get(name) ?? null)), painted);
	}

	/** Take an answer as the state: what is selected now, its tokens, and the rose's own files. */
	async function adopt(client: BridgeClient, data: AppearanceView): Promise<void> {
		const resolved = new Map<string, ResolvedTheme | null>();
		if (data.theme.current !== null) resolved.set(data.theme.current, data.theme.tokens);
		for (const name of namesToResolve(data.theme.current)) {
			resolved.set(name, (await client.appearance({ action: "read", name })).theme.tokens);
		}
		tokens = resolved;
		setView({ data, busy: false, error: null });
		paint();
		setRose(
			await loadRoseSettings(async (file: RoseConfigFile) => (file === "banner.json" ? data.rose.banner : data.rose.animations)),
		);
	}

	async function refresh(): Promise<void> {
		const client = options.connect();
		if (client === null) return;
		try {
			await adopt(client, await client.appearance({ action: "read" }));
		} catch (error) {
			setView((value) => ({ ...value, error: messageOf(error) }));
		}
	}

	async function select(name: string): Promise<void> {
		const client = options.connect();
		if (client === null) {
			setView((value) => ({ ...value, error: "the bridge is not connected, so no theme was chosen" }));
			return;
		}
		setView((value) => ({ ...value, busy: true, error: null }));
		try {
			await adopt(client, await client.appearance({ action: "theme", name }));
		} catch (error) {
			setView((value) => ({ ...value, busy: false, error: messageOf(error) }));
		}
	}

	// `system` follows the OS: a scheme change repaints from the tokens already read, with no round trip.
	const media = typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)");
	const onScheme = (): void => paint();
	media?.addEventListener("change", onScheme);

	function stop(): void {
		media?.removeEventListener("change", onScheme);
		painted = applyCssVariables(style(), null, painted);
	}

	return { view, current, available, rose, refresh, select, stop };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
