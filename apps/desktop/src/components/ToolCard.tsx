import { Show, createSignal } from "solid-js";
import { fileChangeOf, writeTextOf } from "../lib/file-change";
import { FileChangeCard } from "./FileChangeCard";
import type { ChatItem } from "../state/chat";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/**
 * What the reader opened, by item id. The transcript replaces a tool's item on every update, which
 * rebuilds the card, so state held only inside it collapsed the card under the reader's eyes.
 */
const cardState = new Map<string, { open: boolean; args: boolean }>();

/**
 * One tool call. A call that changed a file shows the file instead of a name: the path and the change
 * are what the reader came for. Every other call keeps the summary line that expands into its
 * arguments and output.
 */
export function ToolCard(props: { tool: ToolItem }) {
	const change = () => fileChangeOf(props.tool.name, props.tool.args);
	return (
		<Show when={change()} fallback={<ToolRow tool={props.tool} />}>
			{(fileChange) => (
				<div class={`tool ${props.tool.status}`}>
					<FileChangeCard
						id={props.tool.id}
						change={fileChange()}
						content={writeTextOf(props.tool.args)}
						state={<ToolState tool={props.tool} />}
					/>
				</div>
			)}
		</Show>
	);
}

/** Every tool row states how it ended, in the same place, changed file or not. */
function ToolState(props: { tool: ToolItem }) {
	return (
		<span class="tool-state">
			<Show when={props.tool.status === "running"} fallback={<StatusLabel status={props.tool.status} durationMs={props.tool.durationMs} />}>
				running
			</Show>
		</span>
	);
}

/** A call that changed nothing: the name, a one-value summary, and its output on request. */
function ToolRow(props: { tool: ToolItem }) {
	const id = props.tool.id;
	const [open, setOpenState] = createSignal(cardState.get(id)?.open ?? false);
	const [showArgs, setShowArgsState] = createSignal(cardState.get(id)?.args ?? false);
	const setOpen = (next: (current: boolean) => boolean): void => {
		const value = next(open());
		setOpenState(value);
		cardState.set(id, { open: value, args: showArgs() });
	};
	const setShowArgs = (next: (current: boolean) => boolean): void => {
		const value = next(showArgs());
		setShowArgsState(value);
		cardState.set(id, { open: open(), args: value });
	};
	const preview = () => props.tool.output.split("\n").slice(0, 3).join("\n");
	const summary = (): string => {
		const args = props.tool.args as Record<string, unknown> | null;
		if (!args) return "";
		for (const key of ["command", "path", "file_path", "pattern", "query"]) {
			const value = args[key];
			if (typeof value === "string") return value;
		}
		return "";
	};

	return (
		<div class={`tool ${props.tool.status}`}>
			<button class="tool-head" onClick={() => setOpen((current) => !current)}>
				<span class="chevron-static">{open() ? "▾" : "▸"}</span>
				<span class="tool-name">{props.tool.name}</span>
				<span class="tool-summary">{summary()}</span>
				<ToolState tool={props.tool} />
			</button>

			<Show when={open()}>
				<div class="tool-body">
					<pre class="output">{props.tool.output.length > 0 ? props.tool.output : "(no output yet)"}</pre>
					{/* The header already states the command or path, so raw arguments are opt-in detail. */}
					<Show when={Object.keys((props.tool.args as object | null) ?? {}).length > 0}>
						<button class="tool-toggle" onClick={() => setShowArgs((current) => !current)}>
							{showArgs() ? "hide the arguments" : "arguments"}
						</button>
					</Show>
					<Show when={showArgs()}>
						<pre class="args">{JSON.stringify(props.tool.args, null, 2)}</pre>
					</Show>
				</div>
			</Show>

			<Show when={!open() && props.tool.status !== "running" && preview().length > 0}>
				<pre class="output preview">{preview()}</pre>
			</Show>
		</div>
	);
}

function StatusLabel(props: { status: ToolItem["status"]; durationMs?: number }) {
	return (
		<>
			{props.status === "error" ? "failed" : "done"}
			<Show when={props.durationMs !== undefined}>
				<span class="muted"> · {props.durationMs}ms</span>
			</Show>
		</>
	);
}
