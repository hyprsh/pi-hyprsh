/**
 * Semantic data model shared by capture, measurement and the two views.
 *
 * Pure types — no pi access. Hierarchy and provenance live in typed fields;
 * view code never parses labels to recover source, kind or parentage.
 */

export const PI_SOURCE_ID = "pi";
export const AGGREGATE_SOURCE_ID = "aggregate:extensions";

/** What kind of context data an injection item is. */
export type InjectionKind =
	| "base-prompt"
	| "append-prompt"
	| "context-file"
	| "skills"
	| "tool"
	| "prompt-addition"
	| "message";

/** Who contributed one or more injection items. */
export interface InjectionSource {
	/** Stable internal id, namespaced by source kind. */
	readonly id: string;
	readonly label: string;
	/** True for pi-native components. */
	readonly native: boolean;
}

/** One measured context injection. */
export interface InjectionItem {
	/** Stable id, unique within a snapshot. */
	readonly id: string;
	readonly kind: InjectionKind;
	readonly source: InjectionSource;
	/** Item label without embedded hierarchy or source. */
	readonly label: string;
	/** Estimated tokens (chars/4 heuristic unless measured as a message). */
	readonly tokens: number;
	/** Raw injected text for preview. Process-local; never logged or persisted. */
	readonly text: string;
	/** True when a message exists only in the provider context, not the session branch. */
	readonly contextOnly?: boolean;
	/** Constituent sub-items (individual built-in tools or skills), largest first. */
	readonly children?: readonly InjectionItem[];
}

/** Items of one source, with a precomputed total. */
export interface InjectionGroup {
	readonly source: InjectionSource;
	readonly items: readonly InjectionItem[];
	readonly totalTokens: number;
}

/** The prompt/tool/injection composition presented by the injections view. */
export interface InjectionSnapshot {
	readonly groups: readonly InjectionGroup[];
	readonly totalTokens: number;
}

/** How an invisible reasoning estimate was derived, without retaining signature bytes. */
export interface InvisibleReasoningEstimate {
	readonly tokens: number;
	/** Provider usage breakdown, or the length of an opaque replay signature. */
	readonly basis: "provider-reported" | "signature-proxy";
	/** Whether the message carries an opaque replay signature. */
	readonly encoded: boolean;
}

/** One estimated usage category, optionally with a constituent breakdown. */
export interface UsageCategory {
	/** Stable id, unique within a usage snapshot level. */
	readonly id: string;
	readonly label: string;
	readonly tokens: number;
	/** Breakdown of the parent, not additional totals. */
	readonly children?: readonly UsageCategory[];
	/** Content entries backing the category preview; leaves only. */
	readonly entries?: readonly UsagePreviewEntry[];
}

/** One content entry shown in a usage category preview. */
export interface UsagePreviewEntry {
	/** Message time (epoch ms); absent for prompt-side components. */
	readonly timestamp?: number;
	/** Bracket header cells, e.g. ["assistant", "read"]. */
	readonly breadcrumb: readonly string[];
	/** Tokens this entry contributes, including any counted invisible reasoning. */
	readonly tokens: number;
	/** Visible-text share shown before invisible reasoning metadata. */
	readonly visibleTokens?: number;
	readonly invisibleReasoning?: InvisibleReasoningEstimate;
	/** Raw content for preview. Process-local; never logged or persisted. */
	readonly text: string;
}

/** Pi-reported usage; tokens/percent are absent when unknown, e.g. right after compaction. */
export interface ReportedContextUsage {
	readonly tokens?: number;
	readonly contextWindow: number;
	readonly percent?: number;
}

/** On-demand estimated context composition presented by the usage view. */
export interface ContextUsageSnapshot {
	readonly modelLabel?: string;
	readonly reported?: ReportedContextUsage;
	readonly categories: readonly UsageCategory[];
	/** Sum of the top-level category estimates. */
	readonly estimatedTokens: number;
	/** Auto-compaction reserve; absent when auto-compaction is disabled. */
	readonly autoCompactReserveTokens?: number;
}

/**
 * Group measured items by source: pi-native first, extension sources by total
 * size, the unattributable aggregate last. Items inside a group follow a fixed
 * semantic order (prompt, tools, skills, then everything else by size).
 */
export function groupInjections(items: readonly InjectionItem[]): InjectionGroup[] {
	const groups = new Map<string, { source: InjectionSource; items: InjectionItem[]; totalTokens: number }>();
	for (const item of items) {
		let group = groups.get(item.source.id);
		if (group === undefined) {
			group = { source: item.source, items: [], totalTokens: 0 };
			groups.set(item.source.id, group);
		}
		group.items.push(item);
		group.totalTokens += item.tokens;
	}
	for (const group of groups.values()) group.items.sort(compareItems);
	return [...groups.values()].sort(compareGroups);
}

/** Build a snapshot from measured items. */
export function buildSnapshot(items: readonly InjectionItem[]): InjectionSnapshot {
	const groups = groupInjections(items);
	return {
		groups,
		totalTokens: groups.reduce((sum, group) => sum + group.totalTokens, 0),
	};
}

/** Messages that existed only in the transformed provider context, not the session branch. */
export function contextOnlyMessages(snapshot: InjectionSnapshot | undefined): InjectionItem[] {
	if (snapshot === undefined) return [];
	return snapshot.groups.flatMap((group) =>
		group.items.filter((item) => item.kind === "message" && item.contextOnly === true),
	);
}

/** Prompt first, then built-in tools, other tools, skills, everything else by size. */
function compareItems(a: InjectionItem, b: InjectionItem): number {
	const rankDelta = itemRank(a) - itemRank(b);
	return rankDelta === 0 ? b.tokens - a.tokens : rankDelta;
}

function itemRank(item: InjectionItem): number {
	switch (item.kind) {
		case "base-prompt":
		case "append-prompt":
			return 0;
		case "tool":
			return item.id === "tool:builtin" ? 1 : 2;
		case "skills":
			return 3;
		default:
			return 4;
	}
}

function compareGroups(a: InjectionGroup, b: InjectionGroup): number {
	if (a.source.native !== b.source.native) return a.source.native ? -1 : 1;
	const aAggregate = a.source.id === AGGREGATE_SOURCE_ID;
	const bAggregate = b.source.id === AGGREGATE_SOURCE_ID;
	if (aAggregate !== bAggregate) return aAggregate ? 1 : -1;
	return b.totalTokens - a.totalTokens;
}
