import type { SessionSummary } from "@gentle-shell/protocol";

/** The part of `localStorage` this module uses, so a test can hand it a stand-in. */
export interface TextStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const KEY = "gentle-shell:threads:v1";

/** Newest first, as the bridge sends them; enough for a rail without filling the storage. */
export const MAX_CACHED_THREADS = 200;

/**
 * The thread list as it was the last time the bridge answered.
 *
 * It lets the rail paint at once on a relaunch while the real list is on its way. It is a convenience
 * and never the truth: a missing, unreadable or malformed cache reads as empty, and what is read is
 * checked entry by entry, because anything in `localStorage` can have been written by an older build.
 */
export function readCachedThreads(storage: TextStorage): SessionSummary[] {
	let raw: string | null;
	try {
		raw = storage.getItem(KEY);
	} catch {
		return [];
	}
	if (raw === null) return [];

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];

	const threads: SessionSummary[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (typeof record["path"] !== "string" || typeof record["cwd"] !== "string" || typeof record["title"] !== "string") continue;
		if (typeof record["updatedAt"] !== "number") continue;
		threads.push({
			path: record["path"],
			cwd: record["cwd"],
			title: record["title"],
			updatedAt: record["updatedAt"],
			...(typeof record["model"] === "string" ? { model: record["model"] } : {}),
		});
		if (threads.length === MAX_CACHED_THREADS) break;
	}
	return threads;
}

export function writeCachedThreads(storage: TextStorage, threads: readonly SessionSummary[]): void {
	try {
		storage.setItem(KEY, JSON.stringify(threads.slice(0, MAX_CACHED_THREADS)));
	} catch {
		// A full or blocked storage only means the next launch paints a moment later.
	}
}
