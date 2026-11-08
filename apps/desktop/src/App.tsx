import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { Palette, type PaletteGroup } from "./components/Palette";
import { SettingsSheet, ShortcutsSheet } from "./components/Sheets";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { BINDINGS, createKeymap, isMac, type KeyEventLike } from "./lib/keybindings";
import { folderLabel, relativeTime } from "./lib/threads";
import { createChatController } from "./state/chat";

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? "ws://127.0.0.1:7787/?token=dev";
const PROJECT_LABEL = import.meta.env.VITE_PROJECT_LABEL ?? "";
const MAC = isMac(`${navigator.userAgent} ${navigator.platform}`);

type Sheet = "settings" | "shortcuts" | null;
type PaletteMode = "everything" | "threads" | null;

export default function App() {
	const chat = createChatController({ url: BRIDGE_URL, cwd: "" });
	const [sheet, setSheet] = createSignal<Sheet>(null);
	const [palette, setPalette] = createSignal<PaletteMode>(null);
	const [railOpen, setRailOpen] = createSignal(true);

	onMount(() => {
		void chat.connect();
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
				{ id: "rail", label: "Toggle the rail", hint: format("Mod+B"), run: () => setRailOpen((open) => !open) },
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
				hint: command.description,
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
					setRailOpen((open) => !open);
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
	];

	return (
		<div class="app" classList={{ "rail-closed": !railOpen() }}>
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
				<StatusBar model={chat.model} cost={chat.cost} running={chat.running} />
			</main>

			<Palette open={palette() !== null} onClose={() => setPalette(null)} groups={groups()} />

			<Show when={sheet() === "settings"}>
				<SettingsSheet facts={facts()} onClose={() => setSheet(null)} />
			</Show>
			<Show when={sheet() === "shortcuts"}>
				<ShortcutsSheet onClose={() => setSheet(null)} />
			</Show>
		</div>
	);
}
