/**
 * task — delegate bounded work to child agents.
 *
 * One call carries one or more briefs. Independent units run together, and the
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
	type AgentRun,
	addUsage,
	agentDefinitions,
	emptyUsage,
	findAgent,
	runAgent,
} from "../agents/index.ts";
import { compact } from "../compact/index.ts";
import type { Thresholds } from "../config.ts";
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

export function registerTask(pi: ExtensionAPI, thresholds: Thresholds): void {
	const definitions = agentDefinitions();
	const names = definitions.map((agent) => agent.name);
	const readOnly = new Set(definitions.filter((agent) => !agent.tools.includes("write")).map((a) => a.name));

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
							"One brief per unit of work. Independent units run at the same time, so order carries no meaning.",
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
							content: [{ type: "text", text: formatRuns(active, running) }],
							details: { runs: active },
						});
						requestRender();
					};
					report();

					try {
						const runs = await mapWithLimit(briefs, concurrency, async (brief) => {
							const definition = findAgent(brief.agent);
							if (!definition) throw new Error(`unknown agent: ${brief.agent}`);

							const run = await runAgent(brief.name, definition, renderBrief(brief), {
								cwd: session?.cwd ?? process.cwd(),
								model: session?.model?.id,
								thinkingLevel: session?.thinkingLevel,
								signal,
								onProgress: requestRender,
							});
							active = [...active, run];
							running.delete(brief.name);
							report();
							return run;
						});

						return {
							content: [{ type: "text", text: formatRuns(runs, running) }],
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
