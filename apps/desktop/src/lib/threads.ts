import type { SessionSummary } from "@gentle-shell/protocol";

/** Threads grouped by workspace folder, newest group first. */
export interface ThreadGroup {
	readonly cwd: string;
	readonly label: string;
	readonly items: readonly SessionSummary[];
}

/** Group a newest-first session list by `cwd`, keeping that order inside and between groups. */
export function groupThreads(items: readonly SessionSummary[]): ThreadGroup[] {
	const buckets = new Map<string, SessionSummary[]>();
	for (const item of items) {
		const bucket = buckets.get(item.cwd);
		if (bucket) bucket.push(item);
		else buckets.set(item.cwd, [item]);
	}
	return [...buckets].map(([cwd, list]) => ({ cwd, label: folderLabel(cwd), items: list }));
}

/** Last path segment of a workspace path, for the group heading. */
export function folderLabel(cwd: string): string {
	if (cwd.trim().length === 0) return "unknown project";
	const parts = cwd.split(/[\\/]+/).filter((part) => part.length > 0);
	return parts[parts.length - 1] ?? cwd;
}

/** Compact age labels for the rail: `now`, `3m`, `2h`, `5d`, `2mo`, `1y`. */
export function relativeTime(updatedAt: number, now = Date.now()): string {
	const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;

	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;

	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo`;

	return `${Math.floor(days / 365)}y`;
}
