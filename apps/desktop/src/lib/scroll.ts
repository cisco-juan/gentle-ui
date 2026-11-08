export interface ScrollMetrics {
	readonly scrollTop: number;
	readonly clientHeight: number;
	readonly scrollHeight: number;
}

/** Pixels from the end that still count as "at the bottom", so a rounding gap does not unstick a reader. */
const NEAR_BOTTOM_PX = 80;

/**
 * Whether the reader is following the end of a transcript.
 *
 * A stream that jumps to the bottom on every delta takes the page away from someone who scrolled up
 * to read; following only while they are already at the end leaves them where they chose to be.
 */
export function isNearBottom(metrics: ScrollMetrics): boolean {
	return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= NEAR_BOTTOM_PX;
}

/**
 * Whether to keep following after a wheel gesture.
 *
 * Waiting for the scroll event to report the new position loses a race: a token can arrive first and
 * pin the reader back to the end, so scrolling up during a fast stream feels blocked. A wheel up is
 * the reader asking to look back, and it settles the question immediately; scrolling back down
 * returns to following only once the end is in sight again.
 */
export function followAfterWheel(metrics: ScrollMetrics, deltaY: number): boolean {
	return deltaY < 0 ? false : isNearBottom(metrics);
}
