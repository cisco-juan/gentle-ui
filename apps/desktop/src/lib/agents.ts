import type { AgentCounts, AgentTaskSummary } from "@gentle-shell/protocol";

/**
 * The two rules the Agents tab applies to what the bridge answered.
 *
 * The bridge already orders the list newest first; this keeps that order instead of grouping by status.
 * A run's place is decided by when it started, not by how it ended, so a failed run does not sink below
 * a running one and the rows never move while an agent works.
 */
export function agentOrder(tasks: readonly AgentTaskSummary[]): readonly AgentTaskSummary[] {
	return [...tasks].sort((left, right) => {
		const leftKey = left.startedAt ?? left.createdAt ?? Number.NEGATIVE_INFINITY;
		const rightKey = right.startedAt ?? right.createdAt ?? Number.NEGATIVE_INFINITY;
		if (leftKey !== rightKey) return rightKey > leftKey ? 1 : -1;
		return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
	});
}

/**
 * One line for the tab's header: what is running, then what is queued or waiting while there is any, then
 * what finished. Nothing at all when nothing ran, so an empty tab has one thing to say instead of two.
 */
export function agentCountsLabel(counts: AgentCounts): string {
	const parts = [`${counts.running} running`];
	if (counts.queued > 0) parts.push(`${counts.queued} queued`);
	if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
	parts.push(`${counts.finished} finished`);
	const worthSaying = counts.running + counts.queued + counts.waiting + counts.finished > 0;
	return worthSaying ? parts.join(" · ") : "";
}

/**
 * How long a run took, or how long it has been going when it has not ended yet. The row and the modal
 * share it, so the two never disagree about the same run.
 */
export function agentDuration(task: AgentTaskSummary, now = Date.now()): string | null {
	const started = task.startedAt ?? task.createdAt;
	if (started === null) return null;
	const seconds = Math.round(Math.max(0, (task.endedAt ?? now) - started) / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
