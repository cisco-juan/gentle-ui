import type { PromptImage } from "./attachments";

/**
 * Whether the answer to a `prompt` means an agent run is now in flight.
 *
 * Pi reports `disposition: "handled"` for an extension command: it ran to completion inside the call
 * and no run started, so no `agent_settled` will ever arrive to clear the working state. Any other
 * answer, or none, is treated as a run, which is what an older Pi without the field would be.
 */
export function startsRun(answer: unknown): boolean {
	if (typeof answer !== "object" || answer === null) return true;
	return (answer as { disposition?: unknown }).disposition !== "handled";
}

/** One line for an `extension_error` record, so a crashed command is visible instead of silent. */
export function extensionErrorText(record: Readonly<Record<string, unknown>>): string {
	const cause = typeof record.error === "string" && record.error.length > 0 ? record.error : "unknown error";
	const event = typeof record.event === "string" ? record.event : "";
	const command = event.startsWith("command:") ? event.slice("command:".length) : "";
	return command.length > 0 ? `${command} failed: ${cause}` : `an extension failed: ${cause}`;
}

/**
 * The parameters of a `prompt`, queued behind the run when one is in flight.
 *
 * Pi refuses a prompt that arrives mid-run unless it says how to queue it ("Agent is already
 * processing. Specify streamingBehavior"), and a refusal here used to look like the run had ended.
 */
export function promptParams(
	message: string,
	images: readonly PromptImage[],
	running: boolean,
): Record<string, unknown> {
	return {
		message,
		...(images.length > 0 ? { images } : {}),
		...(running ? { streamingBehavior: "followUp" } : {}),
	};
}

/** True when an extension vetoed a session change (`new_session`, `switch_session`). */
export function wasCancelled(answer: unknown): boolean {
	return typeof answer === "object" && answer !== null && (answer as { cancelled?: unknown }).cancelled === true;
}
