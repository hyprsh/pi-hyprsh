/**
 * Proportional cell model for the usage view's 14×14 context map. The map uses
 * estimated category totals against the selected window or fit scale. Pi's
 * separately reported occupancy may differ because of tokenizer, serialization,
 * caching and last-response timing.
 */

import type { ContextUsageSnapshot } from "../model.ts";

export const MAP_COLUMNS = 14;
export const MAP_ROWS = 14;

const FIT_HEADROOM_PERCENT = 115;
const MINIMUM_FIT_SCALE_TOKENS = 10_000;
const FIT_SCALE_SIGNIFICANT_DIGITS = 2;

/** One map cell assigned to a category, the auto-compact buffer or free space. */
export interface UsageMapCell {
	readonly categoryId?: string;
	readonly fill: "full" | "partial" | "buffer" | "free";
}

/** Rectangular context-usage map in row-major order. */
export interface UsageMap {
	readonly columns: number;
	readonly rows: number;
	/** Tokens one cell represents at the active scale. */
	readonly blockTokens: number;
	readonly cells: readonly UsageMapCell[];
}

interface MapSegment {
	readonly categoryId: string;
	readonly start: number;
	readonly end: number;
}

/**
 * Fit denominator from estimated occupancy: 15% headroom, rounded up to two
 * significant digits, with a 10k floor and the context window as the cap.
 */
export function calculateFitMapScale(usage: ContextUsageSnapshot): number | undefined {
	const contextWindow = usage.reported?.contextWindow;
	if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	const estimatedTotal = usage.categories.reduce((sum, category) => sum + category.tokens, 0);
	const withHeadroom = (Math.max(0, estimatedTotal) * FIT_HEADROOM_PERCENT) / 100;
	const rounded = roundUpToSignificantDigits(withHeadroom, FIT_SCALE_SIGNIFICANT_DIGITS);
	return Math.min(contextWindow, Math.max(MINIMUM_FIT_SCALE_TOKENS, rounded));
}

/**
 * Build a proportional map from estimated categories. `scaleTokens` changes only
 * the mapped denominator; the buffer stays anchored to the true context window.
 */
export function buildUsageMap(usage: ContextUsageSnapshot, scaleTokens?: number): UsageMap | undefined {
	const contextWindow = usage.reported?.contextWindow;
	if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;

	const requestedScale = scaleTokens ?? contextWindow;
	if (!Number.isFinite(requestedScale) || requestedScale <= 0) return undefined;
	const mapScale = Math.min(contextWindow, requestedScale);
	const cellCount = MAP_COLUMNS * MAP_ROWS;
	const estimatedTotal = usage.categories.reduce((sum, category) => sum + category.tokens, 0);
	const occupiedCells = (clamp(estimatedTotal, 0, mapScale) / mapScale) * cellCount;
	// Fit shows its headroom as free space; the true-window buffer stays outside the mapped range.
	const windowOccupancy = clamp(estimatedTotal, 0, contextWindow);
	const bufferTokens =
		mapScale < contextWindow
			? 0
			: clamp(usage.autoCompactReserveTokens ?? 0, 0, contextWindow - windowOccupancy);
	const bufferStart = ((contextWindow - bufferTokens) / mapScale) * cellCount;
	const segments = createSegments(usage, estimatedTotal, occupiedCells);
	return {
		columns: MAP_COLUMNS,
		rows: MAP_ROWS,
		blockTokens: mapScale / cellCount,
		cells: Array.from({ length: cellCount }, (_, index) =>
			createCell(index, occupiedCells, bufferStart, segments),
		),
	};
}

/** Scale estimated category shares into the occupied map range. */
function createSegments(
	usage: ContextUsageSnapshot,
	estimatedTotal: number,
	occupiedCells: number,
): MapSegment[] {
	if (estimatedTotal <= 0 || occupiedCells <= 0) return [];
	const segments: MapSegment[] = [];
	let cursor = 0;
	for (const category of usage.categories) {
		const size = (category.tokens / estimatedTotal) * occupiedCells;
		segments.push({ categoryId: category.id, start: cursor, end: cursor + size });
		cursor += size;
	}
	return segments;
}

/** Assign one cell to its largest category overlap and classify its fill. */
function createCell(
	index: number,
	occupiedCells: number,
	bufferStart: number,
	segments: readonly MapSegment[],
): UsageMapCell {
	if (overlap(index, index + 1, 0, occupiedCells) <= 0) {
		// An unoccupied cell belongs to the buffer when at least half of it lies past the trigger.
		return overlap(index, index + 1, bufferStart, index + 1) >= 0.5 ? { fill: "buffer" } : { fill: "free" };
	}

	let categoryId: string | undefined;
	let categoryOverlap = 0;
	for (const segment of segments) {
		const currentOverlap = overlap(index, index + 1, segment.start, segment.end);
		if (currentOverlap > categoryOverlap) {
			categoryId = segment.categoryId;
			categoryOverlap = currentOverlap;
		}
	}
	return { categoryId, fill: categoryOverlap >= 0.7 ? "full" : "partial" };
}

/** Length shared by two half-open numeric ranges. */
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
	return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Round a positive value up at the requested significant-digit boundary. */
function roundUpToSignificantDigits(value: number, significantDigits: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	const boundary = 10 ** (Math.floor(Math.log10(value)) - significantDigits + 1);
	return Math.ceil(value / boundary) * boundary;
}

/** Restrict a finite value to an inclusive range. */
function clamp(value: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) return minimum;
	return Math.min(maximum, Math.max(minimum, value));
}
