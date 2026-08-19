/**
 * What a delegated unit of work hands back.
 *
 * The split down the middle of this file is the whole point. A child's
 * `verdict` and `report` are self-reported: it says whether its own work
 * passed. Its `evidence` is not — the runtime reads it off the child's own
 * tool calls, so the files it touched and the commands it ran are observed
 * facts rather than a claim in prose. A worker's report never verifies its
 * own work, so the root gets both and trusts only the second.
 */

import type { Usage } from "@earendil-works/pi-ai";

/** The verdict a child is asked to end its report with. */
export const VERDICTS = ["pass", "issues", "blocked"] as const;

export type Verdict = (typeof VERDICTS)[number];

/** `unknown` is a child that ran but never stated a verdict, which is not the same as a failure. */
export type ReportedVerdict = Verdict | "unknown";

/** Observed from the child's tool calls, never from its prose. */
export interface Evidence {
	/** Paths handed to `write` or `edit`. */
	changed: string[];
	/** Command lines handed to `bash`. */
	commands: string[];
}

export interface AgentRun {
	/** The caller's semantic name for this unit, echoed back so results are matched by name and not by arrival order. */
	name: string;
	agent: string;
	model?: string;
	/** Self-reported. */
	verdict: ReportedVerdict;
	/** The child's final assistant message. Self-reported. */
	report: string;
	/** Observed. */
	evidence: Evidence;
	usage: Usage;
	turns: number;
	exitCode: number;
	ms: number;
	/** Set when the child could not be run or died before reporting. */
	failure?: string;
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(into: Usage, add: Usage | undefined): Usage {
	if (!add) return into;
	return {
		input: into.input + (add.input ?? 0),
		output: into.output + (add.output ?? 0),
		cacheRead: into.cacheRead + (add.cacheRead ?? 0),
		cacheWrite: into.cacheWrite + (add.cacheWrite ?? 0),
		totalTokens: into.totalTokens + (add.totalTokens ?? 0),
		cost: {
			input: into.cost.input + (add.cost?.input ?? 0),
			output: into.cost.output + (add.cost?.output ?? 0),
			cacheRead: into.cost.cacheRead + (add.cost?.cacheRead ?? 0),
			cacheWrite: into.cost.cacheWrite + (add.cost?.cacheWrite ?? 0),
			total: into.cost.total + (add.cost?.total ?? 0),
		},
	};
}

/** A run is only worth accepting when the child both finished and said so. */
export function succeeded(run: AgentRun): boolean {
	return run.exitCode === 0 && !run.failure && run.verdict === "pass";
}
