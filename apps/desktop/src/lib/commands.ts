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
		surface: "the Profiles sheet",
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

const MIN_PREFIX = 3;
const MIN_TYPO = 4;
const MAX_TYPO_DISTANCE = 2;

/**
 * A notice for a slash line that names no command this agent has, when one clearly was meant.
 *
 * Only a near miss is reported: a line such as `/home/me/notes.txt` also starts with a slash and is
 * ordinary text, and refusing a real command is worse than forwarding a mistyped one. Without a close
 * candidate, or before the agent has listed its commands, the line goes through untouched.
 */
export function unknownCommandNotice(line: string, known: readonly string[]): string | null {
	if (known.length === 0) return null;
	const typed = line.trim().replace(/^\//, "").split(/\s+/)[0] ?? "";
	if (!/^[a-z0-9][\w:.-]*$/i.test(typed)) return null;

	const wanted = typed.toLowerCase();
	if (INDEX.has(wanted) || known.some((name) => name.toLowerCase() === wanted)) return null;

	const near = closestCommand(wanted, known);
	return near === null ? null : `/${typed} is not a command here. Did you mean /${near}?`;
}

function closestCommand(wanted: string, known: readonly string[]): string | null {
	let best: { name: string; distance: number } | null = null;
	for (const name of known) {
		const lower = name.toLowerCase();
		// Typing the start of a name is the commonest slip: `gentle:profile` for `gentle:profiles`.
		const distance =
			wanted.length >= MIN_PREFIX && lower.startsWith(wanted)
				? lower.length - wanted.length
				: wanted.length >= MIN_TYPO
					? editDistance(wanted, lower)
					: Number.POSITIVE_INFINITY;
		if (distance > MAX_TYPO_DISTANCE) continue;
		if (best === null || distance < best.distance || (distance === best.distance && name.length < best.name.length)) {
			best = { name, distance };
		}
	}
	return best === null ? null : best.name;
}

function editDistance(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row++) {
		const current = [row];
		for (let column = 1; column <= right.length; column++) {
			const cost = left[row - 1] === right[column - 1] ? 0 : 1;
			current[column] = Math.min(
				(previous[column] ?? 0) + 1,
				(current[column - 1] ?? 0) + 1,
				(previous[column - 1] ?? 0) + cost,
			);
		}
		previous = current;
	}
	return previous[right.length] ?? 0;
}

export type ShellAction = "profiles";

/**
 * A line the shell answers with a screen of its own instead of sending it to the agent.
 *
 * Bare `/gentle:profiles` opens a fullscreen terminal screen that cannot run over RPC, so the shell
 * offers the same job as a sheet. With a verb (`export`, `clear`, ...) the line is ordinary agent work and
 * is not an action.
 */
export function shellAction(line: string): ShellAction | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("/")) return null;
	const [name = "", ...rest] = trimmed.slice(1).split(/\s+/);
	return name.toLowerCase() === "gentle:profiles" && rest.length === 0 ? "profiles" : null;
}
