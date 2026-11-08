import { For, Show, createSignal, onCleanup } from "solid-js";
import type { ExtensionUiResponse } from "@gentle-shell/protocol";
import { isSubmitKey } from "../lib/permission";
import type { ChatItem } from "../state/chat";

type PermissionItem = Extract<ChatItem, { kind: "permission" }>;

/**
 * A blocking extension dialog, rendered inline.
 *
 * Pi stops the agent until this is answered, so an unanswered card is a stalled run, not a hint.
 */
export function PermissionCard(props: {
	item: PermissionItem;
	onAnswer: (requestId: string, response: ExtensionUiResponse) => void;
}) {
	const [text, setText] = createSignal(props.item.request.prefill ?? "");
	const request = () => props.item.request;
	const answered = () => props.item.answer !== null;
	const answer = (response: ExtensionUiResponse): void => props.onAnswer(request().id, response);

	// Pi gives up on a dialog that has a timeout and moves on; an answer sent after that is discarded,
	// so a card that stays clickable would let someone decide something that no longer matters.
	const [expired, setExpired] = createSignal(false);
	const limit = request().timeout;
	if (typeof limit === "number" && limit > 0) {
		const timer = setTimeout(() => setExpired(true), limit);
		onCleanup(() => clearTimeout(timer));
	}
	const closed = () => answered() || expired();

	return (
		<div class={`permission ${closed() ? "answered" : ""}`}>
			<header>
				<span class="badge">permission</span>
				<span>{request().title ?? request().method}</span>
			</header>

			<Show when={request().message}>
				<p class="permission-message">{request().message}</p>
			</Show>

			<Show
				when={answered()}
				fallback={
					<Show when={expired()} fallback={<Controls />}>
						<p class="permission-answer">timed out: the agent moved on without an answer</p>
					</Show>
				}
			>
				<p class="permission-answer">answered: {props.item.answer || "(no value)"}</p>
			</Show>
		</div>
	);

	function Controls() {
		return (
			<div class="permission-controls">
				<Show when={request().method === "select"}>
					<For each={request().options ?? []}>
						{(option) => (
							<button class="choice" onClick={() => answer({ value: option })}>
								{option}
							</button>
						)}
					</For>
				</Show>

				<Show when={request().method === "confirm"}>
					<button class="choice primary" onClick={() => answer({ confirmed: true })}>
						Approve
					</button>
					<button class="choice" onClick={() => answer({ confirmed: false })}>
						Reject
					</button>
				</Show>

				<Show when={request().method === "input"}>
					<input
						class="text-input"
						placeholder={request().placeholder ?? "type a value"}
						value={text()}
						onInput={(event) => setText(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (isSubmitKey("input", event)) answer({ value: text() });
						}}
					/>
					<button class="choice primary" onClick={() => answer({ value: text() })}>
						Send
					</button>
				</Show>

				<Show when={request().method === "editor"}>
					{/* An editor holds several lines, so Enter must stay a newline. */}
					<textarea
						class="text-input editor"
						rows={6}
						placeholder={request().placeholder ?? "type a value"}
						value={text()}
						onInput={(event) => setText(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (isSubmitKey("editor", event)) answer({ value: text() });
						}}
					/>
					<button class="choice primary" title="Ctrl or Cmd+Enter" onClick={() => answer({ value: text() })}>
						Send
					</button>
				</Show>

				<button class="choice cancel" onClick={() => answer({ cancelled: true })}>
					Cancel
				</button>
			</div>
		);
	}
}
