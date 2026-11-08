import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { AgentCounts, AgentDetail, AgentItem, AgentList, AgentTaskSummary } from "@gentle-shell/protocol";

/**
 * Subagent activity, read from what gentle-pi already writes.
 *
 * The agent publishes its own activity, one pair of files per Pi incarnation under
 * `<agent home>/gentle-agents/presence/`: `<sessionHash>.<incarnation>.activity.json` holds the runs and
 * their threads, the `.header.json` next to it holds the counters, and the `.discovery.json` says which
 * session and workspace that incarnation belonged to. Nothing here invents a run: a task the files do not
 * carry is not shown.
 *
 * The directory is shared by every thread on the machine, so the file has to be chosen by session, not
 * by recency, or one chat would render another chat's subagents. And because a running agent rewrites
 * these files while this bridge reads them, a payload that does not parse reads as "nothing published"
 * instead of failing the request.
 */

/** Presence files live here, relative to the agent home (`PI_CODING_AGENT_DIR`). */
export const PRESENCE_DIR = join("gentle-agents", "presence");
export const ACTIVITY_SUFFIX = ".activity.json";
export const HEADER_SUFFIX = ".header.json";
export const DISCOVERY_SUFFIX = ".discovery.json";

/** One item longer than this is clipped; a subagent that printed a whole file should not stall the UI. */
export const MAX_ITEM_CHARS = 4_000;
/** A thread longer than this keeps its last items, which are the ones a reader came for. */
export const MAX_ITEMS_PER_TASK = 200;

const ZERO_COUNTS: AgentCounts = { running: 0, queued: 0, waiting: 0, finished: 0 };

/** The three files one Pi incarnation leaves behind, already parsed. */
export interface AgentPresence {
	readonly activity: unknown;
	readonly header: unknown;
	readonly discovery: unknown;
}

export interface AgentLimits {
	readonly maxItemChars?: number;
	readonly maxItems?: number;
}

/** One run as the bridge projects it: the listed summary plus the iteration the modal renders. */
export type ProjectedTask = AgentTaskSummary & { readonly items: readonly AgentItem[] };

export interface AgentProjection {
	readonly counts: AgentCounts;
	/** Newest first: `startedAt ?? createdAt` descending, ties broken by id descending. */
	readonly tasks: readonly ProjectedTask[];
	/** True when a cap hid part of this payload. */
	readonly truncated: boolean;
}

export interface AgentsOptions {
	/** Agent home the presence directory sits under; the server passes the one the child process runs with. */
	readonly agentHome?: string;
}

/**
 * Project the raw presence payloads into what the tab and the modal render.
 *
 * Every field is optional in practice: these files belong to another process, so a missing or hostile
 * field becomes null or an empty value instead of an exception.
 */
export function projectAgents(presence: AgentPresence, limits: AgentLimits = {}): AgentProjection {
	const maxItemChars = limits.maxItemChars ?? MAX_ITEM_CHARS;
	const maxItems = limits.maxItems ?? MAX_ITEMS_PER_TASK;

	const rawTasks = recordOf(recordOf(presence.activity)?.activity)?.tasks;
	let truncated = false;
	const tasks: ProjectedTask[] = [];
	for (const raw of Array.isArray(rawTasks) ? rawTasks : []) {
		const projected = taskOf(raw, maxItemChars, maxItems);
		if (projected === null) continue;
		if (projected.truncated) truncated = true;
		tasks.push(projected.task);
	}
	tasks.sort(newestFirst);

	return { counts: countsOf(presence.header), tasks, truncated };
}

/** The list the tab reads: the summaries with no iteration attached. */
export function listOf(projection: AgentProjection): AgentList {
	return {
		counts: projection.counts,
		tasks: projection.tasks.map((task) => ({
			id: task.id,
			agent: task.agent,
			label: task.label,
			status: task.status,
			model: task.model,
			createdAt: task.createdAt,
			startedAt: task.startedAt,
			endedAt: task.endedAt,
		})),
	};
}

/**
 * One run with its iteration. `truncated` is the projection's flag: it is the file that hit a cap, and
 * this answer describes the only task in it in every case the agent writes.
 */
export function detailOf(projection: AgentProjection, taskId: string): AgentDetail {
	const task = projection.tasks.find((entry) => entry.id === taskId);
	if (task === undefined) throw new Error(`no agent run ${taskId} in the activity this thread published`);
	return {
		id: task.id,
		agent: task.agent,
		label: task.label,
		status: task.status,
		items: task.items,
		truncated: projection.truncated,
	};
}

/** Every run the open thread's agent published, newest first; an empty list when it published none. */
export async function listAgents(options: AgentsOptions & { readonly sessionPath?: string }): Promise<AgentList> {
	const presence = await findPresence(options);
	if (presence === null) return { counts: ZERO_COUNTS, tasks: [] };
	return listOf(projectAgents(presence));
}

/** One run of the open thread, with the iteration it produced. */
export async function agentDetail(
	options: AgentsOptions & { readonly sessionPath?: string; readonly taskId: string },
): Promise<AgentDetail> {
	const presence = await findPresence(options);
	if (presence === null) throw new Error(`no agent run ${options.taskId} in the activity this thread published`);
	return detailOf(projectAgents(presence), options.taskId);
}

/**
 * The presence payload that belongs to `sessionPath`, or null.
 *
 * The session id is what Pi puts in the session file name (`<stamp>_<sessionId>.jsonl`), and the files
 * are named after its sha256, which is also what their discovery record says when it records one. With no
 * session to look for — a fresh thread has no file yet — the newest activity file is the only honest
 * answer. A candidate that resolves, through a symlink, to something outside the presence directory is
 * refused rather than read.
 */
export async function findPresence(options: AgentsOptions & { readonly sessionPath?: string }): Promise<AgentPresence | null> {
	const dir = await presenceDirectory(options);
	if (dir === null) return null;
	const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(ACTIVITY_SUFFIX));
	if (names.length === 0) return null;

	const sessionId = sessionIdOf(options.sessionPath);
	// With no thread named, the newest file is the only honest answer, and reading the rest would not
	// make it more honest.
	if (sessionId === null) return (await describe(dir, await newestActivity(dir, names)))?.presence ?? null;

	const owned = await ownIncarnations(dir, names, sessionId);
	if (owned.length === 0) return null;
	const described = await Promise.all(owned.map((name) => describe(dir, name)));
	const candidates = described.filter((entry) => entry !== null);
	if (candidates.length === 0) return null;
	// A thread leaves several incarnations behind; the one with a run to show wins, then the freshest.
	candidates.sort(
		(left, right) =>
			Number(right.hasTasks) - Number(left.hasTasks) ||
			right.heartbeat - left.heartbeat ||
			right.updatedAt - left.updatedAt ||
			(left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
	);
	return candidates[0]?.presence ?? null;
}

/**
 * The presence files of one session, without reading the activity of files that belong elsewhere.
 *
 * A file is named after the sha256 of its session id, which is cheap to check from the name alone; the
 * discovery record names the session too, so it is the fallback for an incarnation named otherwise.
 */
async function ownIncarnations(dir: string, names: readonly string[], sessionId: string): Promise<readonly string[]> {
	const hash = createHash("sha256").update(sessionId).digest("hex");
	const byName = names.filter((name) => name.startsWith(`${hash}.`));
	if (byName.length > 0) return byName;
	const found: string[] = [];
	for (const name of names) {
		const discovery = await readJson(sibling(join(dir, name), ACTIVITY_SUFFIX, DISCOVERY_SUFFIX));
		if (recordOf(recordOf(recordOf(discovery)?.metadata)?.state)?.sessionId === sessionId) found.push(name);
	}
	return found;
}

/** The activity file written most recently; ties keep the first name so the choice is stable. */
async function newestActivity(dir: string, names: readonly string[]): Promise<string> {
	let newest = names[0] ?? "";
	let newestAt = -1;
	for (const name of names) {
		const stats = await stat(join(dir, name)).catch(() => null);
		const updatedAt = stats?.mtimeMs ?? 0;
		if (updatedAt > newestAt) {
			newest = name;
			newestAt = updatedAt;
		}
	}
	return newest;
}

/** One candidate, read and described, or null when it resolves outside the presence directory. */
async function describe(
	dir: string,
	name: string,
): Promise<{ presence: AgentPresence; hasTasks: boolean; heartbeat: number; updatedAt: number; path: string } | null> {
	const path = await realpath(join(dir, name)).catch(() => null);
	// A file that resolves, through a symlink, to something outside the presence directory is not read.
	if (path === null || !inside(dir, path)) return null;
	const presence = await readPresence(dir, name);
	const stats = await stat(path).catch(() => null);
	return {
		presence,
		hasTasks: tasksOf(presence.activity).length > 0,
		heartbeat: timeOf(recordOf(presence.header)?.heartbeat) ?? 0,
		updatedAt: stats?.mtimeMs ?? 0,
		path,
	};
}

/** The three siblings of one activity file, already parsed; a missing or broken one is null. */
async function readPresence(dir: string, name: string): Promise<AgentPresence> {
	const path = join(dir, name);
	const [activity, header, discovery] = await Promise.all([
		readJson(path),
		readJson(sibling(path, ACTIVITY_SUFFIX, HEADER_SUFFIX)),
		readJson(sibling(path, ACTIVITY_SUFFIX, DISCOVERY_SUFFIX)),
	]);
	return { activity, header, discovery };
}

/** The presence directory as it really is on disk, or null when this machine has none. */
async function presenceDirectory(options: AgentsOptions): Promise<string | null> {
	if (options.agentHome === undefined || options.agentHome.trim().length === 0) return null;
	const dir = await realpath(join(options.agentHome, PRESENCE_DIR)).catch(() => null);
	if (dir === null) return null;
	const stats = await stat(dir).catch(() => null);
	return stats?.isDirectory() === true ? dir : null;
}

/** The session id Pi puts in a session file name, or null when the name carries none. */
function sessionIdOf(sessionPath: string | undefined): string | null {
	if (typeof sessionPath !== "string" || sessionPath.length === 0) return null;
	const name = sessionPath.split(/[\\/]/).pop() ?? "";
	const base = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
	const index = base.lastIndexOf("_");
	if (index < 0 || index === base.length - 1) return null;
	return base.slice(index + 1);
}

/** A resolved path is only read when it stays inside the directory it was listed from. */
function inside(dir: string, path: string): boolean {
	return path !== dir && path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** `<hash>.<incarnation>.activity.json` and its siblings share one base name. */
function sibling(path: string, from: string, to: string): string {
	return path.slice(0, -from.length) + to;
}

async function readJson(path: string): Promise<unknown> {
	const text = await readFile(path, "utf8").catch(() => null);
	if (text === null) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		// A file being rewritten right now is not an error this request can act on.
		return null;
	}
}

function tasksOf(activity: unknown): readonly unknown[] {
	const tasks = recordOf(recordOf(activity)?.activity)?.tasks;
	return Array.isArray(tasks) ? tasks : [];
}

function taskOf(
	raw: unknown,
	maxItemChars: number,
	maxItems: number,
): { task: ProjectedTask; truncated: boolean } | null {
	const entry = recordOf(raw);
	const summary = recordOf(entry?.summary);
	if (summary === null) return null;
	const id = textOf(summary.id);
	if (id === null) return null;

	const items = Array.isArray(recordOf(entry?.thread)?.items) ? (recordOf(entry?.thread)?.items as unknown[]) : [];
	const kept = items.slice(Math.max(0, items.length - maxItems));
	let truncated = kept.length < items.length;
	const projected: AgentItem[] = [];
	for (const item of kept) {
		const step = itemOf(item, maxItemChars);
		if (step === null) continue;
		if (step.truncated) truncated = true;
		projected.push(step.item);
	}

	return {
		task: {
			id,
			agent: textOf(summary.agent) ?? "agent",
			label: textOf(summary.label) ?? id,
			status: textOf(summary.status) ?? "unknown",
			model: textOf(summary.model),
			createdAt: timeOf(summary.createdAt),
			startedAt: timeOf(summary.startedAt),
			endedAt: timeOf(summary.endedAt),
			items: projected,
		},
		truncated,
	};
}

function itemOf(raw: unknown, maxItemChars: number): { item: AgentItem; truncated: boolean } | null {
	const record = recordOf(raw);
	if (record === null) return null;
	if (record.kind === "text" && typeof record.text === "string") {
		const text = clamp(record.text, maxItemChars);
		return { item: { kind: "text", text: text.value }, truncated: text.truncated };
	}
	if (record.kind === "tool") {
		const name = textOf(record.name);
		if (name === null) return null;
		const output = clamp(typeof record.output === "string" ? record.output : "", maxItemChars);
		return { item: { kind: "tool", name, output: output.value }, truncated: output.truncated };
	}
	return null;
}

/** Keep a bounded tail: the end of a step is what a reader is looking for, and the start is long gone. */
function clamp(text: string, limit: number): { value: string; truncated: boolean } {
	if (text.length <= limit) return { value: text, truncated: false };
	return { value: `…${text.slice(text.length - limit)}`, truncated: true };
}

function newestFirst(left: AgentTaskSummary, right: AgentTaskSummary): number {
	const leftKey = left.startedAt ?? left.createdAt ?? Number.NEGATIVE_INFINITY;
	const rightKey = right.startedAt ?? right.createdAt ?? Number.NEGATIVE_INFINITY;
	if (leftKey !== rightKey) return rightKey > leftKey ? 1 : -1;
	return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

function countsOf(header: unknown): AgentCounts {
	const counts = recordOf(recordOf(header)?.counts);
	if (counts === null) return ZERO_COUNTS;
	return {
		running: countOf(counts.running),
		queued: countOf(counts.queued),
		waiting: countOf(counts.waiting),
		finished: countOf(counts.finished),
	};
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function countOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function timeOf(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
