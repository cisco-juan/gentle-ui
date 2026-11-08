/**
 * What a slash command actually does in this host.
 *
 * Gentle Shell registers about three dozen `/gentle:*` commands. Many of them open terminal overlays
 * through the TUI, which do not exist over RPC: sending one produces a warning and nothing else. A
 * desktop shell must know the difference instead of forwarding everything and letting the user read
 * an apology.
 */
export type CommandKind = "agent" | "terminal";

export interface CommandDescription {
	/** Command name without the leading slash. */
	readonly name: string;
	readonly kind: CommandKind;
	/** Why it cannot run here, in the user's words. Only for terminal commands. */
	readonly note?: string;
	/** The surface in this shell that does the same job, when one exists. */
	readonly surface?: string;
}

const TUI_ONLY: readonly CommandDescription[] = [
	{
		name: "gentle:agents",
		kind: "terminal",
		note: "the agents overlay is a terminal view",
		surface: "Agents",
	},
	{
		name: "gentle:history",
		kind: "terminal",
		note: "the session picker is a terminal view",
		surface: "the thread rail",
	},
	{
		name: "gentle:panel",
		kind: "terminal",
		note: "panels are terminal widgets",
		surface: "the inspector",
	},
	{
		name: "gentle:usage",
		kind: "terminal",
		note: "the usage view is a terminal overlay",
		surface: "the status line",
	},
	{
		name: "gentle:stats",
		kind: "terminal",
		note: "the stats view is a terminal overlay",
	},
	{
		name: "gentle:changes",
		kind: "terminal",
		note: "the changes panel is a terminal view",
		surface: "the Changes tab",
	},
	{
		name: "gentle:jobs",
		kind: "terminal",
		note: "the jobs view is a terminal overlay",
	},
	{
		name: "gentle:customize",
		kind: "terminal",
		note: "the visual customiser edits the terminal layout",
		surface: "dragging the panel dividers",
	},
	{
		name: "gentle:banner",
		kind: "terminal",
		note: "the startup banner belongs to the terminal",
	},
	{
		name: "gentle:banner-color",
		kind: "terminal",
		note: "the startup banner belongs to the terminal",
	},
	{
		name: "gentle:toggle-rose",
		kind: "terminal",
		note: "it toggles a terminal logo",
	},
	{
		name: "gentle:toggle-text-logo",
		kind: "terminal",
		note: "it toggles a terminal logo",
	},
	{
		name: "gentle:animations",
		kind: "terminal",
		note: "it toggles terminal animations",
	},
	{
		name: "gentle:vim",
		kind: "terminal",
		note: "it configures the terminal editor",
	},
	{
		name: "gentle:commands",
		kind: "terminal",
		note: "the command list is a terminal view",
		surface: "the palette",
	},
	{
		name: "gentle:design",
		kind: "terminal",
		note: "the design canvas is a terminal view",
	},
	{
		name: "gentle:music",
		kind: "terminal",
		note: "the music controls are a terminal view",
	},
	{
		name: "gentle:voice",
		kind: "terminal",
		note: "the voice controls are a terminal view",
	},
];

const INDEX = new Map<string, CommandDescription>(TUI_ONLY.map((entry) => [entry.name.toLowerCase(), entry]));

/** Unknown commands are assumed to be agent work: refusing a real command is worse than forwarding it. */
export function describeCommand(name: string): CommandDescription {
	return INDEX.get(name.toLowerCase()) ?? { name, kind: "agent" };
}

/** True when the command means something to this host. */
export function isRunnableCommand(name: string): boolean {
	return describeCommand(name).kind === "agent";
}
