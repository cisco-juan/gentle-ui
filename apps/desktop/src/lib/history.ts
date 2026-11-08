/** How close to the top of the transcript counts as asking for the previous page. */
export const OLDER_PAGE_PX = 200;

export interface OlderPageMetrics {
	readonly scrollTop: number;
	/** True while a page is already on its way, so one gesture never asks twice. */
	readonly loading: boolean;
	/** True when the session file has conversation older than what is on screen. */
	readonly hasOlder: boolean;
}

/**
 * Whether reaching this scroll position should read the next older page.
 *
 * A transcript is read from its end backwards: the newest page is already on screen, and only a reader
 * who has climbed to the top of it wants the turns before it. Asking anywhere else would load the whole
 * file on the first small scroll.
 */
export function shouldLoadOlder(metrics: OlderPageMetrics): boolean {
	return metrics.hasOlder && !metrics.loading && metrics.scrollTop <= OLDER_PAGE_PX;
}
