import { For, Match, Show, Switch, createEffect, type Accessor } from "solid-js";
import type { ExtensionUiResponse } from "@gentle-shell/protocol";
import type { ChatItem } from "../state/chat";
import { RichText } from "./RichText";
import { PermissionCard } from "./PermissionCard";
import { ToolCard } from "./ToolCard";

type UserItem = Extract<ChatItem, { kind: "user" }>;
type AssistantItem = Extract<ChatItem, { kind: "assistant" }>;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type PermissionItem = Extract<ChatItem, { kind: "permission" }>;
type NoticeItem = Extract<ChatItem, { kind: "notice" }>;

export function ChatView(props: {
	items: Accessor<ChatItem[]>;
	draft: Accessor<string>;
	running: Accessor<boolean>;
	onAnswer: (requestId: string, response: ExtensionUiResponse) => void;
}) {
	let scroller: HTMLDivElement | undefined;

	createEffect(() => {
		props.items().length;
		props.draft();
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	});

	return (
		<div class="chat" ref={scroller}>
			<Show when={props.items().length === 0 && props.draft().length === 0}>
				<div class="empty">
					<h1>gentle shell</h1>
					<p>
						Your workspace, your agent. Ask for something, or press <kbd>Ctrl</kbd> <kbd>K</kbd> for the palette.
					</p>
				</div>
			</Show>

			<For each={props.items()}>{(item) => <Row item={item} onAnswer={props.onAnswer} />}</For>

			<Show when={props.draft().length > 0}>
				<article class="bubble assistant streaming">
					<header>
						<span class="who">agent</span>
						<span class="cursor" />
					</header>
					<RichText text={props.draft()} />
				</article>
			</Show>

			<Show when={props.running() && props.draft().length === 0}>
				<div class="working">
					<span class="pulse" />
					working… <span class="muted">Esc to interrupt</span>
				</div>
			</Show>
		</div>
	);
}

function Row(props: { item: ChatItem; onAnswer: (requestId: string, response: ExtensionUiResponse) => void }) {
	const item = () => props.item;

	return (
		<Switch>
			<Match when={item().kind === "user" ? (item() as UserItem) : undefined}>
				{(user) => (
					<article class="bubble user">
						<header>
							<span class="who">you</span>
						</header>
						<p class="raw">{user().text}</p>
					</article>
				)}
			</Match>

			<Match when={item().kind === "assistant" ? (item() as AssistantItem) : undefined}>
				{(assistant) => (
					<article class="bubble assistant">
						<header>
							<span class="who">agent</span>
							<Show when={assistant().model}>
								<span class="tag">{assistant().model}</span>
							</Show>
							<Show when={(assistant().cost ?? 0) > 0}>
								<span class="tag cost">${assistant().cost?.toFixed(4)}</span>
							</Show>
						</header>
						<RichText text={assistant().text} />
					</article>
				)}
			</Match>

			<Match when={item().kind === "tool" ? (item() as ToolItem) : undefined}>
				{(tool) => <ToolCard tool={tool()} />}
			</Match>

			<Match when={item().kind === "permission" ? (item() as PermissionItem) : undefined}>
				{(permission) => <PermissionCard item={permission()} onAnswer={props.onAnswer} />}
			</Match>

			<Match when={item().kind === "notice" ? (item() as NoticeItem) : undefined}>
				{(notice) => (
					<div class={`notice ${notice().tone}`}>
						{notice().text}
						<Show when={(notice().repeat ?? 1) > 1}>
							<span class="notice-repeat"> ×{notice().repeat}</span>
						</Show>
					</div>
				)}
			</Match>
		</Switch>
	);
}
