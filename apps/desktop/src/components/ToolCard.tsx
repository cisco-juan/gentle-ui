import { Show, createSignal } from "solid-js";
import type { ChatItem } from "../state/chat";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** One tool call: a collapsed summary line that expands into its arguments and output. */
export function ToolCard(props: { tool: ToolItem }) {
	const [open, setOpen] = createSignal(false);
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
				<span class="chevron">{open() ? "▾" : "▸"}</span>
				<span class="tool-name">{props.tool.name}</span>
				<span class="tool-summary">{summary()}</span>
				<span class="tool-state">
					<Show when={props.tool.status === "running"} fallback={<StatusLabel status={props.tool.status} durationMs={props.tool.durationMs} />}>
						running
					</Show>
				</span>
			</button>

			<Show when={open()}>
				<div class="tool-body">
					<Show when={props.tool.args && Object.keys(props.tool.args as object).length > 0}>
						<pre class="args">{JSON.stringify(props.tool.args, null, 2)}</pre>
					</Show>
					<pre class="output">{props.tool.output.length > 0 ? props.tool.output : "(no output yet)"}</pre>
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
