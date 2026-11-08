/**
 * A file the agent changed, as far as the transcript can tell.
 *
 * Pi emits no diff event: a change is only visible in the arguments of the tool that made it, so the
 * card is derived from `write`/`edit` arguments rather than from any dedicated payload.
 */
export type FileChange =
	| { readonly path: string; readonly kind: "write"; readonly lines: number }
	| {
			readonly path: string;
			readonly kind: "edit";
			readonly hunks: ReadonlyArray<{ readonly removed: string; readonly added: string }>;
	  };

/** A plain object, or nothing: arrays, primitives, functions and null all fail this. */
function recordOf(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/**
 * Lines in a block of text, where a trailing newline ends the last line instead of starting an empty
 * one: a whole file rewritten with a final newline is not one line longer than the same file without.
 */
export function lineCountOf(text: string): number {
	if (text.length === 0) return 0;
	return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").length;
}

/** The text a `write` put on disk; missing or non-string content reads as an empty file. */
export function writeTextOf(args: unknown): string {
	const content = recordOf(args)?.content;
	return typeof content === "string" ? content : "";
}

/** The file a tool touched, under either name a tool uses for it. */
function pathOf(args: Record<string, unknown>): string | null {
	for (const key of ["path", "file_path"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return null;
}

/**
 * The replacements of an `edit`, however this Pi build phrased them: an array, a single object, or the
 * same array as a JSON string. Entries that are not a pair of strings carry no readable change, and a
 * hunk with neither side is an empty edit, so both are dropped rather than shown as an empty card.
 */
function hunksOf(raw: unknown): Array<{ removed: string; added: string }> {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			return [];
		}
	}
	const hunks: Array<{ removed: string; added: string }> = [];
	for (const entry of Array.isArray(value) ? value : [value]) {
		const record = recordOf(entry);
		if (!record) continue;
		const removed = record.oldText;
		const added = record.newText;
		if (typeof removed !== "string" || typeof added !== "string") continue;
		if (removed.length === 0 && added.length === 0) continue;
		hunks.push({ removed, added });
	}
	return hunks;
}

/**
 * Read one tool call as a file change, or nothing.
 *
 * Only `write` and `edit` change a file; every other tool returns null whatever its arguments hold,
 * because a `read` with a path is a file the agent looked at, not one it modified.
 */
export function fileChangeOf(name: string, args: unknown): FileChange | null {
	if (name !== "write" && name !== "edit") return null;
	const record = recordOf(args);
	if (!record) return null;
	const path = pathOf(record);
	if (!path) return null;

	if (name === "write") return { path, kind: "write", lines: lineCountOf(writeTextOf(record)) };

	const hunks = hunksOf(record.edits);
	if (hunks.length === 0) return null;
	return { path, kind: "edit", hunks };
}
