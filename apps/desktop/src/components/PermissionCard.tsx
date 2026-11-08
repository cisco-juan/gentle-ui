import { For, Show, createSignal } from "solid-js";
import type { ExtensionUiResponse } from "@gentle-shell/protocol";
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

	return (
		<div class={`permission ${answered() ? "answered" : ""}`}>
			<header>
				<span class="badge">permission</span>
				<span>{request().title ?? request().method}</span>
			</header>

			<Show when={request().message}>
				<p class="permission-message">{request().message}</p>
			</Show>

			<Show when={answered()} fallback={<Controls />}>
				<p class="permission-answer">answered: {props.item.answer}</p>
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

				<Show when={request().method === "input" || request().method === "editor"}>
					<input
						class="text-input"
						placeholder={request().placeholder ?? "type a value"}
						value={text()}
						onInput={(event) => setText(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") answer({ value: text() });
						}}
					/>
					<button class="choice primary" onClick={() => answer({ value: text() })}>
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
