/** Shapes of the Pi records this UI reads. Derived from observed traffic, not guessed. */

export interface ContentBlock {
	readonly type: string;
	readonly text?: string;
}

export interface AssistantMessage {
	readonly role: "system" | "user" | "assistant" | "tool";
	readonly content: string | readonly ContentBlock[];
	readonly model?: string;
	readonly provider?: string;
	readonly stopReason?: string;
	readonly usage?: {
		readonly input?: number;
		readonly output?: number;
		readonly totalTokens?: number;
		readonly cost?: { readonly total?: number };
	};
}

export interface AssistantStreamEvent {
	readonly type: "text_start" | "text_delta" | "text_end" | "thinking_start" | "thinking_delta" | string;
	readonly contentIndex?: number;
	readonly delta?: string;
}

export interface ToolResultPayload {
	readonly content?: readonly ContentBlock[];
	readonly structuredContent?: Record<string, unknown>;
}

export interface PiEnvelope {
	readonly type: string;
	readonly [key: string]: unknown;
}

export function textOf(content: string | readonly ContentBlock[] | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}
