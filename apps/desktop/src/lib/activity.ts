/** What the last thing in the transcript was, as far as a status line cares. */
export interface ActivityInput {
	readonly running: boolean;
	/** The reply so far, streamed but not yet committed to an item. */
	readonly draft: string;
	readonly lastKind: "user" | "assistant" | "thinking" | "tool" | "permission" | "notice" | null;
	readonly lastName?: string;
	readonly lastStatus?: "running" | "done" | "error";
}

/**
 * The line the transcript shows while the agent is working.
 *
 * A run is not one thing: it thinks, it runs tools, it writes. Saying only "working" leaves the
 * reader unable to tell a slow model from a stuck tool, and showing nothing at all — which is what a
 * pulse limited to an empty draft does — reads as a finished turn.
 */
export function activityOf(input: ActivityInput): string | null {
	if (!input.running) return null;
	if (input.lastKind === "tool" && input.lastStatus === "running") {
		const name = input.lastName?.trim() ?? "";
		return name.length === 0 ? "running a tool" : `running ${name}`;
	}
	if (input.lastKind === "thinking" && input.lastStatus === "running") return "thinking";
	if (input.draft.trim().length > 0) return "writing the answer";
	if (input.lastKind === "permission") return "waiting for your approval";
	return "working";
}
