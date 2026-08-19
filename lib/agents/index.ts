/**
 * The subagent runtime.
 *
 * Spawning children and turning their event streams into results, with no
 * opinion about what a good assignment looks like. The contract a caller must
 * satisfy lives in lib/task, which is the only consumer: this half changes
 * when pi's CLI or event schema changes, that half when the delegation
 * methodology does.
 */

export { type AgentDefinition, agentDefinitions, findAgent } from "./definitions.ts";
export {
	type AgentTier,
	type ModelChoice,
	type ModelRef,
	qualify,
	type Resolution,
	resolveAgentModel,
} from "./model.ts";
export { type RunOptions, runAgent } from "./run.ts";
export {
	type AgentRun,
	addUsage,
	type Evidence,
	emptyUsage,
	type ReportedVerdict,
	succeeded,
	VERDICTS,
	type Verdict,
} from "./types.ts";
