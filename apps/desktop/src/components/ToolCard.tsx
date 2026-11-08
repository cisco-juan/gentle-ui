import { Show, createSignal } from "solid-js";
import type { ChatItem } from "../state/chat";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** One tool call: a collapsed summary line that expands into its arguments and output. */
export function ToolCard(props: { tool: ToolItem }) {
	const [open, setOpen] = createSignal(false);
	const [showArgs, setShowArgs] = createSignal(false);
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
				<span class="tool-state">
					<Show when={props.tool.status === "running"} fallback={<StatusLabel status={props.tool.status} durationMs={props.tool.durationMs} />}>
						running
					</Show>
				</span>
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
