import { onMount } from "solid-js";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { createChatController } from "./state/chat";

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? "ws://127.0.0.1:7787/?token=dev";
const PROJECT_LABEL = import.meta.env.VITE_PROJECT_LABEL ?? "";

export default function App() {
	const chat = createChatController({ url: BRIDGE_URL, cwd: "" });

	onMount(() => {
		void chat.connect();
	});

	return (
		<div class="app">
			<Sidebar
				project={PROJECT_LABEL || "current workspace"}
				connection={chat.connection()}
				statuses={chat.statuses()}
				threads={chat.threads()}
				activePath={chat.activePath()}
				onSelectThread={(path) => void chat.switchThread(path)}
				onNewThread={() => void chat.newThread()}
				onInterrupt={() => void chat.interrupt()}
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
					commands={chat.commands}
				/>
				<StatusBar model={chat.model} cost={chat.cost} running={chat.running} />
			</main>
		</div>
	);
}
