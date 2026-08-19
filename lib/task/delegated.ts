/**
 * What delegation kept out of this window.
 *
 * The argument for a child agent is that it reads on your behalf and hands
 * back a summary, so the reading never reaches your context. That is an
 * assertion until someone counts it. Every `task` result already carries its
 * runs in `details`, and results live on the session branch, so the count is a
 * replay rather than a ledger: it survives /reload, forks and compaction with
 * no disk writes, exactly as the todo list does.
 *
 * Two figures, deliberately not one. `contextTokens` is what the children
 * carried; `resultTokens` is what came back and is sitting in this window now,
 * already counted among the tool results on the map. The ratio between them is
 * the whole claim, and reporting only the saving would hide its price.
 */

import { estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const TOOL_NAME = "task";

/** Aggregate over every `task` result on the branch. */
export interface DelegatedUsage {
	/** Units dispatched, counting a child that failed: it still read before it died. */
	readonly units: number;
	/** Sum of each child's own final context. Never entered this session. */
	readonly contextTokens: number;
	/** What the results put into this window, by the same estimate the map uses. */
	readonly resultTokens: number;
}

/** Read defensively: a result written by an older version of this pack carries no `contextTokens`. */
function readRuns(details: unknown): { contextTokens: number; units: number } | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const runs = (details as { runs?: unknown }).runs;
	if (!Array.isArray(runs) || runs.length === 0) return undefined;

	let contextTokens = 0;
	for (const run of runs) {
		if (!run || typeof run !== "object") return undefined;
		const tokens = (run as { contextTokens?: unknown }).contextTokens;
		if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) contextTokens += tokens;
	}
	return { contextTokens, units: runs.length };
}

/**
 * Every `task` result on the branch, summed.
 *
 * A failed unit counts too. A child that spawned, read and then died still
 * spent its own window rather than this one, which is the thing being measured.
 */
export function replayDelegated(entries: readonly SessionEntry[]): DelegatedUsage | undefined {
	let units = 0;
	let contextTokens = 0;
	let resultTokens = 0;
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== TOOL_NAME) continue;
		const runs = readRuns(message.details);
		if (!runs) continue;
		units += runs.units;
		contextTokens += runs.contextTokens;
		resultTokens += estimateTokens(message);
	}
	return units === 0 ? undefined : { units, contextTokens, resultTokens };
}
