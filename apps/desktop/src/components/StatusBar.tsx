import type { Accessor } from "solid-js";

export function StatusBar(props: { model: Accessor<string>; cost: Accessor<number>; running: Accessor<boolean> }) {
	return (
		<div class="statusbar">
			<span class="left">{props.running() ? "running" : "ready"}</span>
			<span class="right">
				<span class="muted">{props.model()}</span>
				<span class="divider">·</span>
				<span>${props.cost().toFixed(4)}</span>
			</span>
		</div>
	);
}
