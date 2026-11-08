import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { Inspector } from "./components/Inspector";
import { Palette, type PaletteGroup } from "./components/Palette";
import { SettingsSheet, ShortcutsSheet } from "./components/Sheets";
import { Sidebar } from "./components/Sidebar";
import { Splitter } from "./components/Splitter";
import { StatusBar } from "./components/StatusBar";
import { DEV_BRIDGE_URL, resolveBridgeUrl } from "./lib/bridge-endpoint";
import { BINDINGS, createKeymap, isMac, type KeyEventLike } from "./lib/keybindings";
import { describeCommand } from "./lib/commands";
import { gridTemplate } from "./lib/layout";
import { folderLabel, relativeTime } from "./lib/threads";
import { createChatController } from "./state/chat";
import { createLayout } from "./state/layout";

const PROJECT_LABEL = import.meta.env.VITE_PROJECT_LABEL ?? "";
const MAC = isMac(`${navigator.userAgent} ${navigator.platform}`);

type Sheet = "settings" | "shortcuts" | null;
type PaletteMode = "everything" | "threads" | null;

export default function App() {
	/**
	 * The controller reads its endpoint lazily (`connect` and the upload path look at `options.url` each
	 * time), so it can be created before the packaged app knows its bridge port. `resolveBridgeUrl()`
	 * writes the answer here and only then connects; the seed is the development URL, which is all a
	 * browser session ever needs.
	 */
	const endpoint = { url: DEV_BRIDGE_URL, cwd: "" };
	const chat = createChatController(endpoint);
	const [bridgeFailure, setBridgeFailure] = createSignal<string | null>(null);
	const [sheet, setSheet] = createSignal<Sheet>(null);
	const [palette, setPalette] = createSignal<PaletteMode>(null);
	const layout = createLayout();

	// A handle for inspecting the running shell from the console; development builds only.
	if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__chat = chat;

	onMount(() => {
		void (async () => {
			// The connection state stays "connecting" while this runs, which is exactly what the user
			// should see: nothing is connected yet.
			try {
				endpoint.url = await resolveBridgeUrl();
			} catch (error) {
				// Only a packaged build rejects here, and its message says what is wrong with the bundle.
				setBridgeFailure(error instanceof Error ? error.message : String(error));
				return;
			}
			await chat.connect();
		})();
	});

	const groups = createMemo<PaletteGroup[]>(() => {
		const mode = palette();
		if (mode === null) return [];

		const actions: PaletteGroup = {
			title: "Actions",
			items: [
				{ id: "new-thread", label: "New thread", hint: "start a clean session", run: () => void chat.newThread() },
				{ id: "settings", label: "Settings", hint: format("Mod+,"), run: () => setSheet("settings") },
				{ id: "shortcuts", label: "Keyboard shortcuts", hint: format("Mod+Shift+K"), run: () => setSheet("shortcuts") },
				{ id: "rail", label: "Toggle the rail", hint: format("Mod+B"), run: () => layout.toggleRail() },
				{ id: "inspector", label: "Toggle the inspector", hint: format("Mod+Alt+B"), run: () => layout.toggleInspector() },
				{ id: "layout", label: "Reset the layout", hint: "panels back to their default size", run: () => layout.reset() },
				{ id: "interrupt", label: "Interrupt the agent", hint: "Esc", run: () => void chat.interrupt() },
			],
		};

		const threads: PaletteGroup = {
			title: "Threads",
			items: chat.threads().map((thread) => ({
				id: `thread:${thread.path}`,
				label: thread.title,
				hint: `${folderLabel(thread.cwd)} · ${relativeTime(thread.updatedAt)}`,
				run: () => void chat.switchThread(thread.path),
			})),
		};

		if (mode === "threads") return [threads, actions];

		const commands: PaletteGroup = {
			title: "Commands",
			items: chat.commands().map((command) => ({
				id: `command:${command.name}`,
				label: `/${command.name}`,
				hint:
					describeCommand(command.name).kind === "terminal"
						? `${command.description} · terminal only`
						: command.description,
				run: () => void chat.runCommand(command.name),
			})),
		};

		const models: PaletteGroup = {
			title: "Models",
			items: chat.models().map((model) => ({
				id: `model:${model.provider}/${model.id}`,
				label: model.id,
				hint: model.provider,
				run: () => void chat.switchModel(model.provider, model.id),
			})),
		};

		return [actions, threads, commands, models].filter((group) => group.items.length > 0);
	});

	function format(chord: string): string {
		return isMacChord(chord) ? chord.replace("Mod", "⌘").replace("Shift", "⇧") : chord.replace("Mod", "Ctrl");
	}

	function isMacChord(chord: string): boolean {
		return MAC && chord.startsWith("Mod");
	}

	function openPalette(mode: Exclude<PaletteMode, null>): void {
		if (chat.models().length === 0) void chat.loadModels();
		setSheet(null);
		setPalette(mode);
	}

	onMount(() => {
		const resolve = createKeymap(BINDINGS, MAC);
		const onKeyDown = (event: KeyboardEvent): void => {
			// DOM's EventTarget is wider than the keymap's structural view of it; the keymap only reads
			// tagName and isContentEditable from it.
			const binding = resolve(event as unknown as KeyEventLike);
			if (!binding) return;
			event.preventDefault();
			switch (binding.id) {
				case "palette":
					openPalette("everything");
					break;
				case "quick-open":
					openPalette("threads");
					break;
				case "rail":
					layout.toggleRail();
					break;
				case "inspector":
					layout.toggleInspector();
					break;
				case "shortcuts":
					setPalette(null);
					setSheet("shortcuts");
					break;
				case "settings":
					setPalette(null);
					setSheet("settings");
					break;
				case "send":
					// The composer owns the textarea, so it owns submission: relay the intent instead of
					// reaching across components.
					document.dispatchEvent(new CustomEvent("gentle:submit"));
					break;
				case "close":
					if (palette() !== null) setPalette(null);
					else if (sheet() !== null) setSheet(null);
					else void chat.interrupt();
					break;
			}
		};
		window.addEventListener("keydown", onKeyDown);
		onCleanup(() => window.removeEventListener("keydown", onKeyDown));
	});

	const facts = () => [
		{ label: "workspace", value: PROJECT_LABEL || "current workspace" },
		{ label: "model", value: chat.model() || "unknown" },
		{ label: "profile", value: chat.profile() },
		{ label: "permissions", value: chat.permissionMode() },
		{ label: "commands", value: `${chat.commands().length} available` },
		{ label: "threads", value: `${chat.threads().length} saved` },
		{ label: "bridge", value: chat.connection() },
		{ label: "layout", value: `${layout.state().railWidth}px rail · ${layout.state().inspectorWidth}px inspector` },
	];

	return (
		<div
			class="app"
			classList={{ "rail-closed": !layout.effective().railOpen, "inspector-closed": !layout.effective().inspectorOpen }}
			style={{ "grid-template-columns": gridTemplate(layout.effective()) }}
		>
			<Sidebar
				project={PROJECT_LABEL || "current workspace"}
				connection={chat.connection()}
				statuses={chat.statuses()}
				threads={chat.threads()}
				activePath={chat.activePath()}
				onNewThread={() => void chat.newThread()}
				onSelectThread={(path) => void chat.switchThread(path)}
				onOpenSettings={() => setSheet("settings")}
				onOpenShortcuts={() => setSheet("shortcuts")}
			/>

			<Splitter
				edge="rail"
				width={() => layout.effective().railWidth}
				onResize={(width) => layout.resizeRail(width)}
				onReset={() => layout.reset()}
			/>

			<main>
				<ChatView
					items={chat.items}
					draft={chat.draft}
					running={chat.running}
					onAnswer={chat.answerPermission}
				/>
				<Composer
					onSend={(text) => void chat.send(text)}
					onInterrupt={() => void chat.interrupt()}
					running={chat.running}
					model={chat.model}
					profile={chat.profile}
					permissionMode={chat.permissionMode}
					commands={chat.commands}
					models={chat.models}
					onLoadModels={() => void chat.loadModels()}
					onSwitchModel={(provider, id) => void chat.switchModel(provider, id)}
					onRunCommand={(name) => void chat.runCommand(name)}
					onPermissionMode={(mode) => void chat.setPermissionMode(mode)}
				/>
				<StatusBar
					model={chat.model}
					cost={chat.cost}
					running={chat.running}
					hint={chat.hint}
					railOpen={() => layout.state().railOpen}
					inspectorOpen={() => layout.state().inspectorOpen}
					onToggleRail={() => layout.toggleRail()}
					onToggleInspector={() => layout.toggleInspector()}
				/>
			</main>

			<Splitter
				edge="inspector"
				width={() => layout.effective().inspectorWidth}
				onResize={(width) => layout.resizeInspector(width)}
				onReset={() => layout.reset()}
			/>
			<Inspector chat={chat} onClose={() => layout.toggleInspector()} />

			<Palette open={palette() !== null} onClose={() => setPalette(null)} groups={groups()} />

			<Show when={sheet() === "settings"}>
				<SettingsSheet facts={facts()} onClose={() => setSheet(null)} />
			</Show>
			<Show when={sheet() === "shortcuts"}>
				<ShortcutsSheet onClose={() => setSheet(null)} />
			</Show>

			<Show when={bridgeFailure()}>
				{(message) => (
					// A packaged app whose bridge is missing or dead cannot connect at all, so the reason has
					// to be visible: no port, no token, no chat. The styling is inline only because
					// `styles.css` is outside this change; the colours come from the existing
					// `.notice.error` rule.
					<div
						role="alert"
						class="notice error"
						style={{
							position: "fixed",
							"z-index": "12",
							top: "12px",
							left: "50%",
							transform: "translateX(-50%)",
							"max-width": "min(560px, calc(100vw - 40px))",
							"box-shadow": "0 8px 28px rgb(0 0 0 / 0.4)",
						}}
					>
						the bridge did not start: {message()}
					</div>
				)}
			</Show>
		</div>
	);
}
