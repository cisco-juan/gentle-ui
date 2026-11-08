import { For, Show } from "solid-js";
import "../attachments.css";
import { formatBytes, type Attachment } from "../lib/attachments";

/**
 * Pending attachments above the composer.
 *
 * One row per file: the name the user dropped, its size, and — once the bridge answered — the absolute
 * path the agent will read, which is also what the copy-path button puts on the clipboard. An image
 * travels inside the prompt instead of on disk, so it has no path and no copy button.
 */
export function AttachmentStrip(props: {
	entries: readonly Attachment[];
	/** Path copied most recently, so its button can confirm the copy, or null. */
	copied: string | null;
	onRemove: (id: string) => void;
	onCopyPath: (path: string) => void;
}) {
	return (
		<Show when={props.entries.length > 0}>
			<ul class="attachments">
				<For each={props.entries}>
					{(entry) => (
						<li class="attachment" classList={{ uploading: entry.status === "uploading" }}>
							<span class="attachment-name" title={entry.name}>
								{entry.name}
							</span>
							<span class="attachment-size">{formatBytes(entry.size)}</span>
							<Show when={entry.status === "uploading"}>
								<span class="attachment-state">uploading…</span>
							</Show>
							<Show when={entry.path}>
								{(path) => (
									<button
										class="attachment-action"
										title={path()}
										onClick={() => props.onCopyPath(path())}
									>
										{props.copied === path() ? "copied" : "copy path"}
									</button>
								)}
							</Show>
							<button class="attachment-action remove" title="remove" onClick={() => props.onRemove(entry.id)}>
								remove
							</button>
						</li>
					)}
				</For>
			</ul>
		</Show>
	);
}
