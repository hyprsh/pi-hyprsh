/**
 * task — delegate bounded work to child agents.
 *
 * One call carries one or more briefs. Read-only units run together; units that
 * can write run one at a time, since they all share the session's tree. The
 * results come back keyed by the caller's own names so nothing is matched by
 * arrival order.
 *
 * Two things happen before anything is spawned. Ownership conflicts are
 * rejected outright, because two children writing one path is unrecoverable
 * once it has happened. And the fan-out is measured against the provider's
 * remaining subscription quota: this pack already reads that for the footer, so
 * unlike a delegation layer bolted onto a bare agent it can decline to start
 * eight children against an allowance that is nearly spent, which is a mistake
 * the caller cannot see coming and pays for immediately.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type AgentDefinition,
	type AgentRun,
	addUsage,
	agentDefinitions,
	emptyUsage,
	findAgent,
	qualify,
	resolveAgentModel,
	runAgent,
} from "../agents/index.ts";
import { compact } from "../compact/index.ts";
import type { AgentsConfig, Thresholds } from "../config.ts";
import { fetchQuota } from "../quota/index.ts";
import { withReason } from "../reason/index.ts";
import { type Brief, briefSchema, conflicts, renderBrief } from "./brief.ts";
import { formatRuns, panelLines } from "./render.ts";

const WIDGET_KEY = "hyprsh-task";
const MAX_UNITS = 6;
/** Beyond this, children contend for the same API allowance more than they save wall clock. */
const MAX_CONCURRENT = 3;

/** Highest used-percentage across the provider's windows, or null when unknown. */
async function quotaPressure(ctx: ExtensionContext | undefined): Promise<number | null> {
	if (!ctx?.model?.provider) return null;
	try {
		const snapshot = await fetchQuota(ctx.model.provider);
		if (!snapshot || snapshot.error || snapshot.windows.length === 0) return null;
		return Math.max(...snapshot.windows.map((window) => window.percent));
	} catch {
		// The gate is a safety margin, not a gate on correctness: if quota cannot
		// be read the dispatch proceeds rather than failing on an unrelated error.
		return null;
	}
}

async function mapWithLimit<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index] as T);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Readers together, then writers one at a time.
 *
 * `conflicts` already refuses two children that claim the same path, but every
 * child still runs in the session's own tree. Nothing there stops a writer's
 * `npm run check` from observing a sibling's half-finished edits, and a verdict
 * read off that state describes a tree that never existed and never will. A
 * worktree per child would fix it properly and costs an install and a merge;
 * running writers alone costs wall clock on multi-writer fan-outs, which are
 * rare, and nothing otherwise.
 *
 * Results stay in the caller's original order, so a phase never reorders what
 * comes back.
 */
export async function dispatchPhased<T, R>(
	items: readonly T[],
	isReadOnly: (item: T) => boolean,
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	const numbered = items.map((item, index) => ({ item, index }));
	const phases: { entries: typeof numbered; limit: number }[] = [
		{ entries: numbered.filter((entry) => isReadOnly(entry.item)), limit },
		{ entries: numbered.filter((entry) => !isReadOnly(entry.item)), limit: 1 },
	];
	for (const phase of phases) {
		await mapWithLimit(phase.entries, phase.limit, async (entry) => {
			results[entry.index] = await run(entry.item);
		});
	}
	return results;
}

export function registerTask(pi: ExtensionAPI, thresholds: Thresholds, agents: AgentsConfig): void {
	const definitions = agentDefinitions();
	const names = definitions.map((agent) => agent.name);
	const readOnly = new Set(definitions.filter((agent) => !agent.tools.includes("write")).map((a) => a.name));

	const sessionModelRef = () => (session?.model ? qualify(session.model) : undefined);

	/**
	 * Read live rather than cached at startup: which models are available depends
	 * on auth that can change inside a session, and a stale list would send a
	 * child to a model that has since stopped working.
	 */
	const chooseModel = (definition: AgentDefinition) =>
		resolveAgentModel(
			definition,
			{ model: agents.models[definition.name], thinking: agents.thinking[definition.name] },
			session?.modelRegistry?.getAvailable() ?? [],
			session?.model,
		);

	let session: ExtensionContext | undefined;
	let active: AgentRun[] = [];
	let running = new Set<string>();
	let requestRender: () => void = () => {};

	pi.on("session_start", async (_event, ctx) => {
		session = ctx;
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				return {
					dispose() {
						requestRender = () => {};
					},
					invalidate() {},
					render(width: number): string[] {
						return panelLines(active, running, theme, width);
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	});

	pi.registerTool(
		compact(
			withReason({
				name: "task",
				label: "Task",
				description: `Delegate bounded work to child agents, each in its own context window. Available agents: ${definitions
					.map((agent) => `\`${agent.name}\` (${agent.description})`)
					.join(
						"; ",
					)}. A child starts with none of this conversation and reports back once; it cannot ask you anything, so the brief must stand alone.`,
				promptSnippet: "Delegate bounded, independently verifiable work to child agents with the task tool.",
				promptGuidelines: [
					"Delegate to keep bulk out of this context window: wide searches, reading many files, an independent review. Keep tightly coupled work here instead, since children cannot talk to each other.",
					"Give every unit a writable scope, and never let two units in one call write the same path.",
					"A child's verdict is its own claim. Check the diff and rerun the verification yourself before accepting its work.",
				],
				parameters: Type.Object({
					briefs: Type.Array(briefSchema(names), {
						minItems: 1,
						maxItems: MAX_UNITS,
						description:
							"One brief per unit of work. Read-only units run at the same time; units that can write run one after another, in the order given.",
					}),
				}),

				async execute(_toolCallId, params, signal, onUpdate, _ctx) {
					const briefs = params.briefs as Brief[];

					const problems = conflicts(briefs, readOnly);
					if (problems.length > 0) {
						throw new Error(
							`Conflicting briefs, nothing was dispatched:\n${problems.map((p) => `- ${p}`).join("\n")}`,
						);
					}

					const pressure = await quotaPressure(session);
					if (pressure !== null && pressure >= thresholds.critical && briefs.length > 1) {
						throw new Error(
							`Subscription quota is ${Math.round(pressure)}% used, at or past the ${thresholds.critical}% limit. ` +
								`Refusing to start ${briefs.length} children at once. Send one unit, or do the work here.`,
						);
					}
					// Near the limit the work still runs, but it stops racing itself for the same allowance.
					const concurrency = pressure !== null && pressure >= thresholds.warning ? 1 : MAX_CONCURRENT;

					active = [];
					running = new Set(briefs.map((brief) => brief.name));
					requestRender();

					const report = () => {
						onUpdate?.({
							content: [{ type: "text", text: formatRuns(active, running, sessionModelRef()) }],
							details: { runs: active },
						});
						requestRender();
					};
					report();

					try {
						const runs = await dispatchPhased(
							briefs,
							(brief) => readOnly.has(brief.agent),
							concurrency,
							async (brief) => {
								const definition = findAgent(brief.agent);
								if (!definition) throw new Error(`unknown agent: ${brief.agent}`);

								const choice = chooseModel(definition);
								// Inheriting still qualifies the session's own model: a bare ID is
								// ambiguous for the child even when it was unambiguous for the parent.
								const ref = choice.model ?? session?.model;
								const run = await runAgent(brief.name, definition, renderBrief(brief), {
									cwd: session?.cwd ?? process.cwd(),
									model: ref ? qualify(ref) : undefined,
									ignoredModel: choice.ignored,
									thinkingLevel: choice.inheritThinking ? session?.thinkingLevel : choice.thinking,
									signal,
									onProgress: requestRender,
								});
								active = [...active, run];
								running.delete(brief.name);
								report();
								return run;
							},
						);

						return {
							content: [{ type: "text", text: formatRuns(runs, running, sessionModelRef()) }],
							details: { runs },
							// Children's spend is real spend; roll it into this session's accounting.
							usage: runs.reduce((total, run) => addUsage(total, run.usage), emptyUsage()),
						};
					} finally {
						running.clear();
						requestRender();
					}
				},
			}),
		),
	);
}
