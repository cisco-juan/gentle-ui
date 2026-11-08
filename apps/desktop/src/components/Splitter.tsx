import { createSignal } from "solid-js";

/**
 * Draggable divider between two panels.
 *
 * Uses pointer capture so a fast drag cannot slip out of the 6px target, reports the delta from the
 * width it started at (not from the previous move), and resets on double click.
 */
export function Splitter(props: {
	/** Which panel this divider resizes. */
	edge: "rail" | "inspector";
	width: () => number;
	onResize: (width: number) => void;
	onReset: () => void;
}) {
	const [dragging, setDragging] = createSignal(false);
	let startX = 0;
	let startWidth = 0;

	const sign = () => (props.edge === "rail" ? 1 : -1);

	return (
		<div
			class="splitter"
			classList={{ dragging: dragging() }}
			role="separator"
			aria-orientation="vertical"
			title="Drag to resize, double click to reset"
			onPointerDown={(event) => {
				event.preventDefault();
				startX = event.clientX;
				startWidth = props.width();
				setDragging(true);
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				if (!dragging()) return;
				props.onResize(startWidth + sign() * (event.clientX - startX));
			}}
			onPointerUp={(event) => {
				if (!dragging()) return;
				setDragging(false);
				event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			onPointerCancel={() => setDragging(false)}
			onDblClick={() => props.onReset()}
		/>
	);
}
