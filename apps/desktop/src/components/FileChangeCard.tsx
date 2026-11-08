import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { lineCountOf, type FileChange } from "../lib/file-change";

/** Lines of a written file shown on request; the rest is a note, because a new file is not a diff. */
const WRITE_PREVIEW = 40;

/** What the reader opened, by item id: the transcript replaces a tool's item on every update. */
const expanded = new Map<string, boolean>();

type DiffLine = { readonly kind: "remove" | "add"; readonly text: string };

/** The lines of one side of a hunk; an empty side contributes nothing. */
function splitLines(text: string): readonly string[] {
	if (text.length === 0) return [];
	return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** `/abs/dir/file.ts` as the directory to keep quiet and the name to keep readable. */
function splitPath(path: string): { dir: string; base: string } {
	const cut = path.lastIndexOf("/");
	if (cut < 0) return { dir: "", base: path };
	return { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) };
}

/**
 * One changed file: the path, what the change did to it, and the change itself on request.
 *
 * A tool call that edits a file is worth more than its name: the reader wants the path and the lines
 * that moved. It stays collapsed so a long run of edits does not bury the answer, and the header is a
 * real button so the same card opens from the keyboard.
 */
export function FileChangeCard(props: {
	change: FileChange;
	/** The text a `write` put on disk; only a `write` uses it, and only when opened. */
	content?: string;
	/** The owning tool's state, kept where every other tool row shows it. */
	state?: JSX.Element;
	/** Item id, so an update that rebuilds the row does not close the card under the reader. */
	id?: string;
}) {
	const key = (): string => props.id ?? props.change.path;
	const [open, setOpenState] = createSignal(expanded.get(key()) ?? false);
	const setOpen = (next: (current: boolean) => boolean): void => {
		const value = next(open());
		setOpenState(value);
		expanded.set(key(), value);
	};

	const parts = (): { dir: string; base: string } => splitPath(props.change.path);

	const stats = (): string => {
		const change = props.change;
		if (change.kind === "write") return `${change.lines} ${change.lines === 1 ? "line" : "lines"}`;
		let added = 0;
		let removed = 0;
		for (const hunk of change.hunks) {
			added += lineCountOf(hunk.added);
			removed += lineCountOf(hunk.removed);
		}
		return `+${added} −${removed}`;
	};

	const diffLines = (): DiffLine[] => {
		const change = props.change;
		if (change.kind !== "edit") return [];
		const lines: DiffLine[] = [];
		for (const hunk of change.hunks) {
			for (const text of splitLines(hunk.removed)) lines.push({ kind: "remove", text });
			for (const text of splitLines(hunk.added)) lines.push({ kind: "add", text });
		}
		return lines;
	};

	const written = (): readonly string[] => splitLines(props.content ?? "");
	const rest = (): number => Math.max(0, written().length - WRITE_PREVIEW);

	return (
		<div class="file-change">
			<button class="file-change-head" aria-expanded={open()} onClick={() => setOpen((current) => !current)}>
				<span class="chevron-static">{open() ? "▾" : "▸"}</span>
				<span class="file-change-path">
					<Show when={parts().dir.length > 0}>
						<span class="file-change-dir">{parts().dir}</span>
					</Show>
					{parts().base}
				</span>
				<span class="file-change-stats">{stats()}</span>
				{props.state}
			</button>

			<Show when={open()}>
				<Show
					when={props.change.kind === "edit"}
					fallback={
						<>
							<pre class="file-change-body">{written().slice(0, WRITE_PREVIEW).join("\n")}</pre>
							<Show when={rest() > 0}>
								<div class="file-change-more muted">and {rest()} more lines</div>
							</Show>
						</>
					}
				>
					<pre class="file-change-body">
						<For each={diffLines()}>
							{(line) => (
								<span class={`diff-line ${line.kind}`}>
									<span class="diff-gutter">{line.kind === "remove" ? "−" : "+"}</span>
									{line.text}
								</span>
							)}
						</For>
					</pre>
				</Show>
			</Show>
		</div>
	);
}
