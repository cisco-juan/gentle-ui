/**
 * What a slash command actually does in this host.
 *
 * Gentle Shell registers 36 commands. Over RPC there is no overlay, no fullscreen view and no
 * terminal modal: `ctx.ui.custom()` returns undefined, so a terminal-only command runs, draws
 * nothing, and either warns or silently does nothing. This table is the difference between forwarding
 * a command and lying to the user about what happened.
 *
 * Evidence: the registration and its guard in the package (`extensions/*.ts`), plus Pi's own RPC
 * extension-UI limits. A command is only listed as terminal when its handler needs the terminal.
 */
export type CommandKind = "agent" | "terminal";

export interface CommandDescription {
	/** Command name without the leading slash. */
	readonly name: string;
	readonly kind: CommandKind;
	/** Why the bare form cannot run here, in the user's words. */
	readonly note?: string;
	/** The surface in this shell that does the same job, when one exists. */
	readonly surface?: string;
	/**
	 * First arguments that make the command safe anyway: several commands open an overlay only when
	 * they have nothing to do (`gentle:profiles export` never touches the picker, `gentle:mode status`
	 * only reads).
	 */
	readonly safeArgs?: readonly string[];
}

const COMMANDS: readonly CommandDescription[] = [
	{
		name: "gentle:agents",
		kind: "terminal",
		note: "the subagent list is a fullscreen terminal overlay",
		surface: "the Agents tab",
	},
	{
		name: "gentle:panel",
		kind: "terminal",
		note: "the panel sheet is a terminal layout",
		surface: "the inspector",
	},
	{
		name: "gentle:changes",
		kind: "terminal",
		note: "the diff browser is a fullscreen terminal view",
		surface: "the Changes tab",
	},
	{
		name: "gentle:jobs",
		kind: "terminal",
		note: "the jobs list with output tails is a terminal overlay",
	},
	{
		name: "gentle:commands",
		kind: "terminal",
		note: "the command sheet is the terminal palette",
		surface: "the palette",
	},
	{
		name: "gentle:customize",
		kind: "terminal",
		note: "the customiser is a two-column terminal modal",
		surface: "the settings sheet and the panel dividers",
	},
	{
		name: "gentle:profiles",
		kind: "terminal",
		note: "the bare command opens the fullscreen models screen",
		surface: "the model chip in the composer",
		safeArgs: ["export", "import", "publish", "clear", "export-routing", "restore-routing"],
	},
	{
		name: "gentle:mode",
		kind: "terminal",
		note: "permission changes are refused outside a terminal session",
		surface: "the permissions chip",
		safeArgs: ["status"],
	},
	{
		name: "gentle:yolo",
		kind: "terminal",
		note: "permission changes are refused outside a terminal session",
		surface: "the permissions chip",
		safeArgs: ["status"],
	},
	{
		name: "gentle:usage",
		kind: "terminal",
		note: "the usage windows overlay is a terminal view",
	},
	{
		name: "gentle:stats",
		kind: "terminal",
		note: "the activity heatmap overlay is a terminal view",
	},
	{
		name: "gentle:guide",
		kind: "terminal",
		note: "the guided tour steps through terminal popovers",
		surface: "asking the agent for the tour instead",
	},
	{
		name: "gentle:music",
		kind: "terminal",
		note: "gentle-stream takes over the terminal",
	},
	{
		name: "gentle:voice",
		kind: "terminal",
		note: "dictation writes into the terminal editor",
	},
	{
		name: "gentle:review-session-permission",
		kind: "terminal",
		note: "its session identity is only captured inside a terminal",
	},
	{
		name: "history",
		kind: "terminal",
		note: "prompt history is searched in a terminal overlay",
	},
];

const INDEX = new Map<string, CommandDescription>(COMMANDS.map((entry) => [entry.name.toLowerCase(), entry]));

export interface CommandVerdict {
	/** True when the command means something to this host as written. */
	readonly runnable: boolean;
	readonly description: CommandDescription;
}

/**
 * Judge a command line, not just a name.
 *
 * `gentle:profiles export` is agent work while bare `gentle:profiles` is a terminal screen, so the
 * first argument decides.
 */
export function checkCommand(line: string): CommandVerdict {
	const trimmed = line.trim().replace(/^\//, "");
	const [name = "", argument] = trimmed.split(/\s+/);
	const description = INDEX.get(name.toLowerCase()) ?? { name, kind: "agent" };
	if (description.kind === "agent") return { runnable: true, description };

	const allowed = (description.safeArgs ?? []).some((safe) => safe === argument?.toLowerCase());
	return { runnable: allowed, description };
}

/** Convenience for a bare name, which is all a suggestion row knows. */
export function isRunnableCommand(name: string): boolean {
	return checkCommand(name).runnable;
}

export function describeCommand(name: string): CommandDescription {
	return checkCommand(name).description;
}
