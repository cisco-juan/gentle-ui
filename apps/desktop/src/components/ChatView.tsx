import { ErrorBoundary, For, Match, Show, Switch, createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import type { ExtensionUiResponse } from "@gentle-shell/protocol";
import { activityOf } from "../lib/activity";
import { formatChord, isMac } from "../lib/keybindings";
import { followAfterWheel, isNearBottom } from "../lib/scroll";
import type { ChatItem } from "../state/chat";
import { RichText } from "./RichText";
import { PermissionCard } from "./PermissionCard";
import { ToolCard } from "./ToolCard";
import { Skeleton } from "./Skeleton";

const PLATFORM_MAC = isMac(`${navigator.userAgent} ${navigator.platform}`);

type UserItem = Extract<ChatItem, { kind: "user" }>;
type AssistantItem = Extract<ChatItem, { kind: "assistant" }>;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type PermissionItem = Extract<ChatItem, { kind: "permission" }>;
type NoticeItem = Extract<ChatItem, { kind: "notice" }>;
type ThinkingItem = Extract<ChatItem, { kind: "thinking" }>;

/** The shape of a conversation, shown while a thread is being opened or the agent is still starting. */
function ChatSkeleton() {
	return (
		<div class="skeleton-chat" role="status" aria-busy="true" aria-label="Loading the conversation">
			<div class="skeleton-bubble">
				<Skeleton width="34px" height="9px" />
				<Skeleton width="42%" height="12px" />
			</div>
			<div class="skeleton-bubble">
				<Skeleton width="42px" height="9px" />
				<Skeleton width="94%" height="11px" />
				<Skeleton width="88%" height="11px" />
				<Skeleton width="72%" height="11px" />
			</div>
			<div class="skeleton-bubble">
				<Skeleton width="34px" height="9px" />
				<Skeleton width="56%" height="12px" />
			</div>
		</div>
	);
}

export function ChatView(props: {
	/** True while there is nothing to show yet because the content is on its way. */
	loading: Accessor<boolean>;
	items: Accessor<ChatItem[]>;
	draft: Accessor<string>;
	running: Accessor<boolean>;
	onAnswer: (requestId: string, response: ExtensionUiResponse) => void;
}) {
	let scroller: HTMLDivElement | undefined;
	// Follow the stream only while the reader is at its end; scrolling up to read must stick.
	let following = true;

	createEffect(() => {
		const items = props.items();
		props.draft();
		// Sending a message is a request to see the answer, wherever the reader had scrolled to.
		if (items[items.length - 1]?.kind === "user") following = true;
		if (following && scroller) scroller.scrollTop = scroller.scrollHeight;
	});

	const activity = createMemo(() => {
		const items = props.items();
		const last = items[items.length - 1] ?? null;
		return activityOf({
			running: props.running(),
			draft: props.draft(),
			lastKind: last?.kind ?? null,
			lastName: last?.kind === "tool" ? last.name : undefined,
			lastStatus:
				last?.kind === "tool" || last?.kind === "thinking"
					? last.status
					: last?.kind === "permission"
						? "running"
						: undefined,
		});
	});

	return (
		<div
			class="chat"
			ref={scroller}
			onScroll={() => {
				if (scroller) following = isNearBottom(scroller);
			}}
			onWheel={(event) => {
				// Settled by the gesture itself: a stream that lands between the wheel and the scroll event
				// would otherwise pin the reader back to the end and make scrolling feel blocked.
				if (scroller) following = followAfterWheel(scroller, event.deltaY);
			}}
		>
			<Show when={props.loading()}>
				<ChatSkeleton />
			</Show>

			<Show when={!props.loading() && props.items().length === 0 && props.draft().length === 0}>
				<div class="empty">
					<h1>gentle shell</h1>
					<p>
						Your workspace, your agent. Ask for something, or press <kbd>{formatChord("Mod+K", PLATFORM_MAC)}</kbd>{" "}
						for the palette.
					</p>
				</div>
			</Show>

			<For each={props.loading() ? [] : props.items()}>
				{(item) => (
					// One row that cannot render must not take the transcript with it: the error would otherwise abort
					// every later update at the same place and leave the pane blank.
					<ErrorBoundary fallback={(error) => <BrokenRow item={item} error={error} />}>
						<Row item={item} onAnswer={props.onAnswer} />
					</ErrorBoundary>
				)}
			</For>

			<Show when={props.draft().length > 0}>
				<article class="bubble assistant streaming">
					<header>
						<span class="who">agent</span>
						<span class="cursor" />
					</header>
					<RichText text={props.draft()} />
				</article>
			</Show>

			<Show when={activity()}>{(line) => (
				<div class="working" role="status" aria-live="polite">
					<span class="pulse" />
					{line()}… <span class="muted">Esc to interrupt</span>
				</div>
			)}</Show>
		</div>
	);
}

/** How much of the reasoning the header shows: enough to recognise it, not enough to read it there. */
const THINKING_PEEK = 120;

/**
 * The first line of the reasoning, flattened and cut to a header's width.
 *
 * Reasoning arrives in fragments and can be empty, all newlines, or a single unbroken line, so the
 * peek is derived rather than sliced: a header that wraps or throws stops being a header.
 */
function thinkingPeek(text: string): string {
	const first = text.split("\n").find((line) => line.trim().length > 0) ?? "";
	const flat = first.trim().replace(/\s+/g, " ");
	return flat.length > THINKING_PEEK ? `${flat.slice(0, THINKING_PEEK).trimEnd()}…` : flat;
}

/**
 * The model's reasoning: a summary line while it streams, the whole text on request.
 *
 * A run that is still thinking opens it, because the reader is waiting on it; a finished block
 * collapses, because the answer is what they came for and reasoning is the working behind it.
 */
function ThinkingBlock(props: { item: ThinkingItem }) {
	const [open, setOpen] = createSignal(props.item.status === "running");
	const peek = (): string => thinkingPeek(props.item.text);
	const chars = (): number => props.item.text.trim().length;

	return (
		<div class="thinking" classList={{ running: props.item.status === "running" }}>
			<button class="thinking-head" aria-expanded={open()} onClick={() => setOpen((current) => !current)}>
				<span class="chevron-static">{open() ? "▾" : "▸"}</span>
				<span class="thinking-label">thinking</span>
				<span class="thinking-peek">{peek()}</span>
				<span class="thinking-count">{chars()} chars</span>
			</button>

			<Show when={open()}>
				<pre class="thinking-body">{props.item.text}</pre>
			</Show>
		</div>
	);
}

/** What stands in for a row that threw while rendering: its raw text, so nothing said is lost. */
function BrokenRow(props: { item: ChatItem; error: unknown }) {
	const text = (): string => ("text" in props.item ? props.item.text : "");
	return (
		<div class="notice warning" role="alert">
			This message could not be displayed ({props.error instanceof Error ? props.error.message : String(props.error)}).
			<Show when={text().length > 0}>
				<pre class="broken-raw">{text()}</pre>
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

			<Match when={item().kind === "thinking" ? (item() as ThinkingItem) : undefined}>
				{(thinking) => <ThinkingBlock item={thinking()} />}
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
