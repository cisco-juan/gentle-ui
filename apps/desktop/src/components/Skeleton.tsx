import { For, type JSX } from "solid-js";

/**
 * A placeholder shaped like what is coming, shown while the real content is on its way.
 *
 * It is a loading state, not decoration: whatever it stands in for must be replaced the moment the data
 * arrives or fails, and never left up to hide an error. The shimmer stops under `prefers-reduced-motion`.
 */
export function Skeleton(props: { width?: string; height?: string; class?: string }): JSX.Element {
	return (
		<span
			class={`skeleton${props.class === undefined ? "" : ` ${props.class}`}`}
			style={{ ...(props.width === undefined ? {} : { width: props.width }), ...(props.height === undefined ? {} : { height: props.height }) }}
			aria-hidden="true"
		/>
	);
}

/** A stack of text-line skeletons of uneven length, which reads as text rather than as a bar chart. */
export function SkeletonLines(props: { count?: number; label: string }): JSX.Element {
	const widths = ["92%", "78%", "86%", "64%", "74%", "58%"];
	const lines = () => Array.from({ length: props.count ?? 3 }, (_, index) => widths[index % widths.length] ?? "80%");
	return (
		<div class="skeleton-lines" role="status" aria-busy="true" aria-label={props.label}>
			<For each={lines()}>{(width) => <Skeleton width={width} height="10px" />}</For>
		</div>
	);
}
