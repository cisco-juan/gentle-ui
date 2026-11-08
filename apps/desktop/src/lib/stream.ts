import type { AssistantStreamEvent } from "./records.ts";

/** What one stream event means for the transcript. */
export type StreamIntent =
	| { readonly kind: "text"; readonly delta: string }
	| { readonly kind: "thinking"; readonly delta: string }
	| { readonly kind: "ignore" };

/**
 * Read one `message_update` event.
 *
 * The stream carries more than the reply: block boundaries, tool-call fragments and the model's own
 * thinking. Only text and thinking belong in the transcript as they arrive; everything else is
 * ignored here rather than shown as text, because a boundary marker is not a sentence.
 */
export function streamIntent(event: AssistantStreamEvent): StreamIntent {
	const delta = typeof event.delta === "string" ? event.delta : "";
	if (delta.length === 0) return { kind: "ignore" };
	if (event.type === "text_delta") return { kind: "text", delta };
	if (event.type === "thinking_delta") return { kind: "thinking", delta };
	return { kind: "ignore" };
}
