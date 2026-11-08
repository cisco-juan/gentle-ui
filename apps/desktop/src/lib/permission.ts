import type { ExtensionUiResponse } from "@gentle-shell/protocol";

/** What an answered card says it decided: a word for each outcome, never a bare `false`. */
export function answerLabel(response: ExtensionUiResponse): string {
	if (response.cancelled === true) return "cancelled";
	if (response.value !== undefined) return response.value;
	if (response.confirmed === true) return "approved";
	if (response.confirmed === false) return "rejected";
	return "";
}

export interface SubmitKey {
	readonly key: string;
	/** True while an input method editor is still choosing a candidate. */
	readonly isComposing: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
}

/**
 * Whether a key press answers the dialog.
 *
 * A one-line input sends on Enter. A multi-line editor needs Enter for the newline, so it sends on
 * Ctrl or Cmd+Enter. Enter that ends an IME composition is part of typing, not a send.
 */
export function isSubmitKey(method: string, event: SubmitKey): boolean {
	if (event.key !== "Enter" || event.isComposing) return false;
	if (method === "input") return true;
	if (method === "editor") return event.ctrlKey || event.metaKey;
	return false;
}
