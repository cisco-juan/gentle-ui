import type { PermissionMode } from "@gentle-shell/protocol";

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
