import { createSignal, onCleanup } from "solid-js";

/**
 * Draggable divider between two panels.
 *
 * The drag listens on `window`, not on the divider: a six-pixel target is easy to slip off, and a
 * listener bound to the element can be lost when Solid re-renders it, which leaves the shell resizing
 * forever after one stray pointer. Releasing anywhere — including outside the window — ends the drag.
 * Double click resets.
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
	let stop: (() => void) | null = null;

	const sign = () => (props.edge === "rail" ? 1 : -1);

	function begin(event: PointerEvent): void {
		if (event.button !== 0) return;
		event.preventDefault();
		startX = event.clientX;
		startWidth = props.width();
		setDragging(true);
		document.body.classList.add("resizing");

		const move = (moveEvent: PointerEvent): void => {
			props.onResize(startWidth + sign() * (moveEvent.clientX - startX));
		};
		const end = (): void => {
			stop?.();
		};

		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", end);
		window.addEventListener("blur", end);

		stop = () => {
			setDragging(false);
			document.body.classList.remove("resizing");
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
			window.removeEventListener("blur", end);
			stop = null;
		};
	}

	onCleanup(() => stop?.());

	return (
		<div
			class="splitter"
			classList={{ dragging: dragging() }}
			role="separator"
			aria-orientation="vertical"
			title="Drag to resize, double click to reset"
			onPointerDown={begin}
			onDblClick={() => props.onReset()}
		/>
	);
}
