import type { PermissionMode, PermissionsView } from "@gentle-shell/protocol";

/** Every mode Pi has, in the order the menu shows them. */
const MODES: readonly PermissionMode[] = ["normal", "auto", "yolo", "super-yolo"];

/** What the UI may write as the default for new threads: lowering only, never yolo or super-yolo. */
export function isSettable(mode: string): mode is "normal" | "auto" {
	return mode === "normal" || mode === "auto";
}

/** The real mode of the open thread, from the `gentle:mode` status Pi publishes ("Permissions: NORMAL"). */
export function parsePermissionStatus(text: string | undefined): PermissionMode | null {
	const match = /^Permissions:\s*(normal|auto|yolo|super-yolo)$/i.exec(text ?? "");
	return match === null ? null : (match[1]?.toLowerCase() as PermissionMode);
}

/** An elevated mode is chosen in a terminal; these are the lines to paste there. */
export function terminalCommands(mode: PermissionMode): { thread: string; newThreads: string } {
	return { thread: `/gentle:mode ${mode}`, newThreads: `/gentle:mode default ${mode}` };
}

/**
 * One row of the permission menu, decided from the bridge's answer alone.
 *
 * `current` is the default new threads start in, which is the only thing this menu writes. The open
 * thread keeps the mode it started with, so a row being current says nothing about it.
 */
export interface PermissionRow {
	readonly mode: PermissionMode;
	/** True when the UI may write this mode as the default for new threads. */
	readonly settable: boolean;
	/** The default new threads start in, as the bridge last reported it. */
	readonly current: boolean;
	/** For a mode this menu may not write: the line that sets it in a terminal. */
	readonly terminal: string | null;
}

/**
 * The four rows of the permission menu. Before the bridge answers, the local rule stands in for its
 * list, so the menu is never empty and never claims an elevated mode is writable.
 */
export function permissionRows(view: PermissionsView | null): readonly PermissionRow[] {
	const settable: readonly PermissionMode[] = view === null ? MODES.filter((mode) => isSettable(mode)) : view.settable;
	return MODES.map((mode) => {
		const writable = settable.includes(mode);
		return {
			mode,
			settable: writable,
			current: view?.default === mode,
			terminal: writable ? null : terminalCommands(mode).newThreads,
		};
	});
}
