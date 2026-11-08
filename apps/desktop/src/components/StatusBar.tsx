import { Show, type Accessor } from "solid-js";
import { Icon } from "./Icon";

/**
 * Status line.
 *
 * It also hosts the panel toggles, because a panel you can close must be reachable again from
 * somewhere always visible — a keyboard chord alone is not a discoverable way back.
 */
export function StatusBar(props: {
	connection: Accessor<"connecting" | "connected" | "failed" | "disconnected">;
	onReconnect: () => void;
	model: Accessor<string>;
	cost: Accessor<number>;
	running: Accessor<boolean>;
	hint: Accessor<string>;
	railOpen: Accessor<boolean>;
	inspectorOpen: Accessor<boolean>;
	onToggleRail: () => void;
	onToggleInspector: () => void;
}) {
	// "ready" while the bridge is down is a lie the user acts on, so the connection comes first.
	const label = (): string => {
		const state = props.connection();
		if (state === "connecting") return "connecting…";
		if (state === "failed") return "bridge unreachable";
		if (state === "disconnected") return "disconnected";
		return props.running() ? "running" : "ready";
	};
	const canReconnect = (): boolean => props.connection() === "failed" || props.connection() === "disconnected";

	return (
		<div class="statusbar">
			<span class="left">
				{label()}
				<Show when={canReconnect()}>
					<button class="status-reconnect" onClick={() => props.onReconnect()}>
						reconnect
					</button>
				</Show>
				<Show when={props.hint().length > 0}>
					<span class="status-hint">{props.hint()}</span>
				</Show>
			</span>
			<span class="right">
				<span class="muted">{props.model()}</span>
				<span class="divider">·</span>
				<span>${props.cost().toFixed(4)}</span>
				<span class="divider">·</span>
				<button
					class="panel-toggle"
					classList={{ on: props.railOpen() }}
					title={`${props.railOpen() ? "Hide" : "Show"} the rail`}
					onClick={() => props.onToggleRail()}
				>
					<Icon name="panel" size={13} />
				</button>
				<button
					class="panel-toggle"
					classList={{ on: props.inspectorOpen() }}
					title={`${props.inspectorOpen() ? "Hide" : "Show"} the inspector`}
					onClick={() => props.onToggleInspector()}
				>
					<Icon name="panel-right" size={13} />
				</button>
			</span>
		</div>
	);
}
