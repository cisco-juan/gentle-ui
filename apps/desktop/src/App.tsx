import { Show, createSignal, onMount } from "solid-js";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { SettingsSheet, ShortcutsSheet } from "./components/Sheets";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { createChatController } from "./state/chat";

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? "ws://127.0.0.1:7787/?token=dev";
const PROJECT_LABEL = import.meta.env.VITE_PROJECT_LABEL ?? "";

export default function App() {
	const chat = createChatController({ url: BRIDGE_URL, cwd: "" });
	const [sheet, setSheet] = createSignal<"settings" | "shortcuts" | null>(null);

	onMount(() => {
		void chat.connect();
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
		<div class="app">
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

			<Show when={sheet() === "settings"}>
				<SettingsSheet facts={facts()} onClose={() => setSheet(null)} />
			</Show>
			<Show when={sheet() === "shortcuts"}>
				<ShortcutsSheet onClose={() => setSheet(null)} />
			</Show>
		</div>
	);
}
