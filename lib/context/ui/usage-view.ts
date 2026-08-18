/**
 * `/context usage`: estimated context composition as a proportional map, a
 * selectable category legend and an Enter-opened content preview.
 */

import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ContextUsageSnapshot, UsageCategory, UsagePreviewEntry } from "../model.ts";
import { collectPreviewEntries } from "../usage.ts";
import {
	BODY_INDENT,
	calculateViewport,
	DEFAULT_TERMINAL_ROWS,
	fitLine,
	fitToTerminalHeight,
	hintRow,
	isStepBackKey,
	isStepForwardKey,
	leaderLine,
	normalizeTerminalRows,
	STEP_KEY_HINT,
	spreadLine,
	wrapDescriptionLines,
} from "./layout.ts";
import { ListNavigator, normalizeInlineText, normalizePreviewText, PreviewScroller } from "./list.ts";
import { buildUsageMap, calculateFitMapScale, type UsageMap, type UsageMapCell } from "./map.ts";

const USAGE_DESCRIPTION =
	"Estimated context for the next model request. " +
	"Token counts are approximate and may differ from the provider's estimate.";
const REASONING_DESCRIPTION =
	"≈ is a provider-reported reasoning count; ~ is a rough approximation " +
	"from the size of an opaque replay signature. Encoded replaces Reasoning when the provider " +
	"replays encrypted reasoning with its message.";
const TAIL_FIXED_LINE_COUNT = 5;
const CATEGORY_HEADER_LINE_COUNT = 1;
const PREVIEW_FIXED_LINE_COUNT = 8;
const PREVIEW_ENTRY_MAX_LINES = 20;
const CURSOR_COLUMN_WIDTH = 2;
const MAX_LEGEND_VALUE_COLUMN = 32;
const LEGEND_VALUE_GAP = 2;
const LEGEND_LEADER_GAP = 4;
const MAP_SIDE_BY_SIDE_MIN_WIDTH = 52;
const SPACED_MAP_MIN_WIDTH = 72;
const MAP_COLUMN_GAP = 2;
const SPACED_MAP_COLUMN_GAP = 3;
const FULL_CELL = "■";
const PARTIAL_CELL = "◧";
const COMPACTED_CELL = "▦";
const BUFFER_CELL = "⛝";
const FREE_CELL = "⛶";
const BREAKDOWN_MARKER = "•";
/** Rows the map key costs beside the complete legend: one separator plus four key rows. */
const MAP_KEY_SPARE_ROWS = 5;

/** Everything the usage view renders, classified once when the view opens. */
export interface UsageViewInput {
	readonly usage: ContextUsageSnapshot;
	readonly degradedReason?: string;
}

/** View-local denominator selected for the context map. */
type UsageMapScale = "window" | "fit";

interface CategoryLegendRow {
	readonly type: "category";
	readonly category: UsageCategory;
	readonly depth: number;
	readonly rootId: string;
}

type LegendRow =
	| CategoryLegendRow
	| { readonly type: "buffer"; readonly tokens: number }
	| { readonly type: "free"; readonly tokens: number };

/** Open the usage view as a fullscreen overlay. */
export async function showUsageView(context: ExtensionCommandContext, input: UsageViewInput): Promise<void> {
	await context.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const view = new UsageView(theme, input, done, () => tui.terminal.rows);
			return {
				render: (width: number) => view.render(width),
				invalidate: () => view.invalidate(),
				handleInput: (data: string) => {
					view.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } },
	);
}

class UsageView {
	private readonly theme: Theme;
	private readonly input: UsageViewInput;
	private readonly done: (result: undefined) => void;
	private readonly getTerminalRows: () => number;
	private readonly usage: ContextUsageSnapshot;
	private readonly legendRows: readonly LegendRow[];
	private readonly navigator: ListNavigator;
	private readonly previewScroller = new PreviewScroller();
	private readonly fitMapScale: number | undefined;
	private mapScale: UsageMapScale = "window";
	private currentWidth: number | undefined;
	private previewRow: CategoryLegendRow | undefined;
	private cachedPreviewEntries: readonly UsagePreviewEntry[] | undefined;
	private previewLines: string[] | undefined;
	private previewWrapWidth: number | undefined;
	private cachedWidth: number | undefined;
	private cachedTerminalRows: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		theme: Theme,
		input: UsageViewInput,
		done: (result: undefined) => void,
		getTerminalRows: () => number = () => process.stdout.rows ?? DEFAULT_TERMINAL_ROWS,
	) {
		this.theme = theme;
		this.input = input;
		this.done = done;
		this.getTerminalRows = getTerminalRows;
		this.usage = input.usage;
		this.fitMapScale = calculateFitMapScale(this.usage);
		this.legendRows = this.buildLegendRows();
		// The trailing buffer/free rows scroll with the list but are never selectable.
		const selectableCount = this.legendRows.filter((row) => row.type === "category").length;
		this.navigator = new ListNavigator(this.legendRows.length, 1, selectableCount);
	}

	handleInput(data: string): void {
		if (this.previewRow !== undefined) {
			this.handlePreviewInput(data);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "z")) {
			this.toggleMapScale();
		} else if (matchesKey(data, Key.enter)) {
			this.openPreview();
		} else if (isStepBackKey(data)) {
			if (this.navigator.moveBy(-1)) this.clearCache();
		} else if (isStepForwardKey(data)) {
			if (this.navigator.moveBy(1)) this.clearCache();
		} else if (matchesKey(data, Key.pageUp)) {
			if (this.navigator.page(-1)) this.clearCache();
		} else if (matchesKey(data, Key.pageDown)) {
			if (this.navigator.page(1)) this.clearCache();
		} else if (matchesKey(data, Key.home)) {
			if (this.navigator.moveTo(0)) this.clearCache();
		} else if (matchesKey(data, Key.end)) {
			if (this.navigator.moveTo(this.legendRows.length - 1)) this.clearCache();
		}
	}

	render(width: number): string[] {
		this.currentWidth = width;
		const terminalRows = normalizeTerminalRows(this.getTerminalRows());
		if (
			this.cachedLines !== undefined &&
			this.cachedWidth === width &&
			this.cachedTerminalRows === terminalRows
		) {
			return this.cachedLines;
		}
		const lines =
			this.previewRow === undefined
				? this.renderDashboard(width, terminalRows)
				: this.renderPreview(width, terminalRows, this.previewRow);
		this.cachedWidth = width;
		this.cachedTerminalRows = terminalRows;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.previewLines = undefined;
		this.previewWrapWidth = undefined;
		this.clearCache();
	}

	// === Dashboard ===

	/** Map, legend and navigation hints. */
	private renderDashboard(width: number, terminalRows: number): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const prefix = [border, "", ...this.headerLines(width), "", ...this.degradedWarningLines(width)];
		const descriptionLines = wrapDescriptionLines(theme, USAGE_DESCRIPTION, "dim", width);
		const availableRows = Math.max(
			1,
			terminalRows - prefix.length - TAIL_FIXED_LINE_COUNT - descriptionLines.length,
		);
		const dashboard = this.dashboardLines(width, availableRows).slice(0, availableRows);
		while (dashboard.length < availableRows) dashboard.push("");
		const tail = [
			"",
			...descriptionLines,
			"",
			fitLine(hintRow(theme, this.dashboardHints(width)), width),
			"",
			border,
		];
		return fitToTerminalHeight([...prefix, ...dashboard, ...tail], terminalRows, border);
	}

	/** Title with the model, an active zoom label and pi-reported usage metadata. */
	private headerLines(width: number): string[] {
		const theme = this.theme;
		const separator = theme.fg("dim", " · ");
		const summary = this.reportedSummary();
		const zoomLabel = this.zoomLabel(width);
		let title = theme.fg("accent", theme.bold("Context Usage"));
		if (zoomLabel !== undefined) title = `${title}${separator}${zoomLabel}`;
		if (width < MAP_SIDE_BY_SIDE_MIN_WIDTH) return [fitLine(title, width), "", fitLine(summary, width)];

		const model = normalizeInlineText(this.usage.modelLabel ?? "");
		const metadata = model === "" ? summary : `${theme.fg("muted", model)}${separator}${summary}`;
		if (visibleWidth(title) + 1 + visibleWidth(metadata) <= width) {
			return [spreadLine(title, metadata, width)];
		}
		if (visibleWidth(title) + 1 + visibleWidth(summary) <= width) {
			return [spreadLine(title, summary, width)];
		}
		return [fitLine(title, width), "", fitLine(summary, width)];
	}

	/** Toggle the map denominator when the binding is currently visible. */
	private toggleMapScale(): void {
		if (!this.canToggleMapScale(this.currentWidth)) return;
		this.mapScale = this.mapScale === "window" ? "fit" : "window";
		this.clearCache();
	}

	/** Whether zoom can help and its binding is visible at this width. */
	private canToggleMapScale(width: number | undefined): boolean {
		const contextWindow = this.usage.reported?.contextWindow;
		return (
			width !== undefined &&
			width >= MAP_SIDE_BY_SIDE_MIN_WIDTH &&
			contextWindow !== undefined &&
			this.fitMapScale !== undefined &&
			this.fitMapScale < contextWindow
		);
	}

	/** The active fit label, omitted together with its map and binding. */
	private zoomLabel(width: number): string | undefined {
		const contextWindow = this.usage.reported?.contextWindow;
		if (
			this.mapScale !== "fit" ||
			!this.canToggleMapScale(width) ||
			contextWindow === undefined ||
			this.fitMapScale === undefined
		)
			return undefined;
		return this.theme.fg(
			"mdHeading",
			`Zoom ${formatTokens(contextWindow)} → ${formatTokens(this.fitMapScale)}`,
		);
	}

	private dashboardHints(width: number): Array<readonly [string, string]> {
		const hints: Array<readonly [string, string]> = [
			[STEP_KEY_HINT, "Navigate"],
			["Enter", "Preview"],
		];
		if (this.canToggleMapScale(width)) hints.push(["Z", "Zoom"]);
		hints.push(["Esc", "Close"]);
		return hints;
	}

	/** Map and legend side by side, or only the legend when width or window data is insufficient. */
	private dashboardLines(width: number, rows: number): string[] {
		const map = buildUsageMap(this.usage, this.mapScale === "fit" ? this.fitMapScale : undefined);
		if (map === undefined || width < MAP_SIDE_BY_SIDE_MIN_WIDTH) {
			return this.detailLines(width, rows, undefined).map((line) => fitLine(line, width));
		}

		const spaced = width >= SPACED_MAP_MIN_WIDTH;
		const separator = spaced ? " " : "";
		const mapLines = Array.from({ length: map.rows }, (_, row) => {
			const cells = map.cells.slice(row * map.columns, row * map.columns + map.columns);
			return `${BODY_INDENT}${cells.map((cell) => this.mapCell(cell)).join(separator)}`;
		});
		const mapWidth = BODY_INDENT.length + map.columns + (spaced ? map.columns - 1 : 0);
		const gap = spaced ? SPACED_MAP_COLUMN_GAP : MAP_COLUMN_GAP;
		const detailWidth = Math.max(1, width - mapWidth - gap);
		const details = this.detailLines(detailWidth, rows, map);
		const lineCount = Math.max(mapLines.length, details.length);
		return Array.from({ length: lineCount }, (_, index) => {
			const mapLine = mapLines[index] ?? " ".repeat(mapWidth);
			return fitLine(`${mapLine}${" ".repeat(gap)}${fitLine(details[index] ?? "", detailWidth)}`, width);
		});
	}

	/** Category heading, legend viewport, scroll counter and map key. */
	private detailLines(width: number, rows: number, map: UsageMap | undefined): string[] {
		const theme = this.theme;
		const keyLines = map === undefined ? [] : this.mapKeyLines(map, width, rows);
		const reserved = CATEGORY_HEADER_LINE_COUNT + (keyLines.length === 0 ? 0 : keyLines.length + 1);
		const viewport = calculateViewport(this.legendRows.length, rows, reserved);
		this.navigator.setVisibleCount(viewport.visibleCount);

		const rowWidth = Math.max(1, width - CURSOR_COLUMN_WIDTH);
		const valueColumn = this.legendValueColumn(rowWidth);
		const visibleRows: string[] = [];
		const start = this.navigator.offset;
		for (let index = start; index < start + this.navigator.windowSize; index++) {
			const row = this.legendRows[index];
			if (row === undefined) break;
			const selected = index === this.navigator.selected;
			const cursor = selected ? theme.fg("accent", "→ ") : "  ";
			visibleRows.push(fitLine(`${cursor}${this.legendLine(row, valueColumn, rowWidth, selected)}`, width));
		}
		const counter = viewport.showScroll
			? [
					fitLine(
						theme.fg("dim", `${BODY_INDENT}(${this.navigator.visibleEnd}/${this.legendRows.length})`),
						width,
					),
				]
			: [];
		return [
			theme.fg("mdHeading", theme.bold("Category:")),
			...visibleRows,
			...counter,
			...(keyLines.length === 0 ? [] : ["", ...keyLines]),
		].slice(0, rows);
	}

	/**
	 * Map key: one heading plus a row per occupancy glyph and the block size. It
	 * claims only rows the complete legend leaves over, so a shrinking terminal
	 * drops the key before any category row goes.
	 */
	private mapKeyLines(map: UsageMap, width: number, rows: number): string[] {
		if (rows - CATEGORY_HEADER_LINE_COUNT - this.legendRows.length < MAP_KEY_SPARE_ROWS) return [];
		const theme = this.theme;
		const sizeLabel = theme.fg("muted", "Block Size: ");
		const entry = (glyphColor: ThemeColor, glyph: string, text: string) =>
			fitLine(`${BODY_INDENT}${theme.fg(glyphColor, glyph)}${theme.fg("dim", " - ")}${text}`, width);
		return [
			fitLine(theme.fg("mdHeading", theme.bold("Map:")), width),
			entry("text", FULL_CELL, theme.fg("muted", "Single category block")),
			entry("text", PARTIAL_CELL, theme.fg("muted", "Shared block, largest category shown")),
			entry("dim", FREE_CELL, `${sizeLabel}${this.blockSizeText(map)}`),
		];
	}

	/** Tokens one map cell covers, with its share of the mapped range. */
	private blockSizeText(map: UsageMap): string {
		const percent = formatPercent(1 / (map.columns * map.rows));
		return this.theme.fg(
			this.mapScale === "fit" ? "mdHeading" : "muted",
			`${formatTokens(Math.round(map.blockTokens))} (${percent})`,
		);
	}

	/** Pi-reported usage, marked as an estimate when current usage is unknown. */
	private reportedSummary(): string {
		const reported = this.usage.reported;
		if (reported === undefined) return this.theme.fg("muted", "Context usage unavailable.");
		const contextWindow = formatTokens(reported.contextWindow);
		if (reported.tokens === undefined) {
			const percent = formatPercent(this.usage.estimatedTokens / reported.contextWindow);
			return this.theme.fg(
				"text",
				`≈${formatTokens(this.usage.estimatedTokens)}/${contextWindow} (${percent})`,
			);
		}
		const percent = reported.percent === undefined ? "" : ` (${formatPercent(reported.percent / 100)})`;
		return this.theme.fg("text", `${formatTokens(reported.tokens)}/${contextWindow}${percent}`);
	}

	/** Top-level categories, tool-output children, then the non-selectable buffer and free space. */
	private buildLegendRows(): LegendRow[] {
		const rows: LegendRow[] = [];
		for (const category of this.usage.categories) {
			rows.push({ type: "category", category, depth: 0, rootId: category.id });
			if (category.id !== "tool-output") continue;
			for (const child of category.children ?? []) {
				rows.push({ type: "category", category: child, depth: 1, rootId: category.id });
			}
		}
		const bufferTokens = this.bufferTokens();
		if (bufferTokens > 0) rows.push({ type: "buffer", tokens: bufferTokens });
		const freeTokens = this.freeSpaceTokens();
		if (freeTokens !== undefined) rows.push({ type: "free", tokens: freeTokens });
		return rows;
	}

	/** Tokens auto-compaction keeps unoccupied; zero when disabled or without a window. */
	private bufferTokens(): number {
		const contextWindow = this.usage.reported?.contextWindow;
		const reserve = this.usage.autoCompactReserveTokens;
		if (contextWindow === undefined || contextWindow <= 0 || reserve === undefined) return 0;
		return Math.min(reserve, Math.max(0, contextWindow - this.usage.estimatedTokens));
	}

	/** Estimated remaining space before the buffer. */
	private freeSpaceTokens(): number | undefined {
		const contextWindow = this.usage.reported?.contextWindow;
		if (contextWindow === undefined || contextWindow <= 0) return undefined;
		return Math.max(0, contextWindow - this.usage.estimatedTokens - this.bufferTokens());
	}

	/** Earliest shared token column that still fits the value columns. */
	private legendValueColumn(width: number): number {
		const rows = this.legendRows;
		const labelWidth = Math.max(1, ...rows.map((row) => this.plainLegendLabel(row).length));
		const tokenWidth = this.legendTokenWidth();
		const percentWidth = Math.max(0, ...rows.map((row) => this.legendPercent(legendTokens(row)).length));
		const rightWidth = tokenWidth + (percentWidth > 0 ? LEGEND_VALUE_GAP + percentWidth : 0);
		const ideal = Math.min(MAX_LEGEND_VALUE_COLUMN, labelWidth + LEGEND_LEADER_GAP);
		return Math.max(1, Math.min(ideal, width - rightWidth));
	}

	private legendTokenWidth(): number {
		return Math.max(1, ...this.legendRows.map((row) => formatTokens(legendTokens(row)).length));
	}

	/** One aligned row with dim leaders and independent token and percentage columns. */
	private legendLine(row: LegendRow, valueColumn: number, width: number, selected: boolean): string {
		const left = fitLine(this.styledLegendLabel(row, selected), Math.max(1, valueColumn - 1));
		const leader = leaderLine(this.theme, valueColumn - visibleWidth(left));
		const tokens = formatTokens(legendTokens(row));
		const valueColor = selected ? "accent" : row.type === "category" && row.depth > 1 ? "dim" : "muted";
		const tokenPadding = " ".repeat(Math.max(0, this.legendTokenWidth() - tokens.length));
		const percent = this.legendPercent(legendTokens(row));
		const percentPart =
			percent === ""
				? ""
				: `${" ".repeat(LEGEND_VALUE_GAP)}${this.theme.fg(selected ? "accent" : "dim", percent)}`;
		return fitLine(
			`${left}${leader}${this.theme.fg(valueColor, tokens)}${tokenPadding}${percentPart}`,
			width,
		);
	}

	/** Unstyled hierarchy label used to choose the shared value column. */
	private plainLegendLabel(row: LegendRow): string {
		if (row.type === "buffer") return `${BUFFER_CELL} Auto-Compact Buffer`;
		if (row.type === "free") return `${FREE_CELL} Free Space`;
		const indent = "  ".repeat(row.depth);
		return `${indent}${categoryMarker(row.category.id, row.depth)} ${normalizeInlineText(row.category.label)}`;
	}

	/** Themed hierarchy label; the marker keeps its map colour even when selected. */
	private styledLegendLabel(row: LegendRow, selected: boolean): string {
		const theme = this.theme;
		if (row.type === "buffer") {
			return `${theme.fg("dim", BUFFER_CELL)} ${theme.fg("text", "Auto-Compact Buffer")}`;
		}
		if (row.type === "free") {
			return `${theme.fg("dim", FREE_CELL)} ${theme.fg(selected ? "accent" : "text", "Free Space")}`;
		}
		const indent = "  ".repeat(row.depth);
		const marker = theme.fg(categoryColor(row.rootId), categoryMarker(row.category.id, row.depth));
		const labelColor = selected ? "accent" : row.depth === 0 ? "text" : "muted";
		return `${indent}${marker} ${theme.fg(labelColor, normalizeInlineText(row.category.label))}`;
	}

	/** Percentage text for the independently aligned rightmost column. */
	private legendPercent(tokens: number): string {
		const contextWindow = this.usage.reported?.contextWindow;
		if (contextWindow === undefined || contextWindow <= 0) return "";
		return formatPercent(tokens / contextWindow);
	}

	/** Coloured occupied, partial, buffer or free glyph for one map cell. */
	private mapCell(cell: UsageMapCell): string {
		if (cell.fill === "buffer") return this.theme.fg("dim", BUFFER_CELL);
		if (cell.fill === "free") return this.theme.fg("dim", FREE_CELL);
		const glyph =
			cell.categoryId === "compacted-data" ? COMPACTED_CELL : cell.fill === "full" ? FULL_CELL : PARTIAL_CELL;
		return this.theme.fg(categoryColor(cell.categoryId), glyph);
	}

	/** Wrapped warning placed above the dashboard when capture was incomplete. */
	private degradedWarningLines(width: number): string[] {
		if (this.input.degradedReason === undefined) return [];
		const reason = normalizeInlineText(this.input.degradedReason);
		return wrapTextWithAnsi(this.theme.fg("warning", `${BODY_INDENT}${reason}`), width);
	}

	// === Preview ===

	private handlePreviewInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.closePreview();
			return;
		}
		if (isStepBackKey(data)) {
			if (this.previewScroller.scrollBy(-1)) this.clearCache();
		} else if (isStepForwardKey(data)) {
			if (this.previewScroller.scrollBy(1)) this.clearCache();
		} else if (matchesKey(data, Key.pageUp)) {
			if (this.previewScroller.page(-1)) this.clearCache();
		} else if (matchesKey(data, Key.pageDown)) {
			if (this.previewScroller.page(1)) this.clearCache();
		} else if (matchesKey(data, Key.home)) {
			if (this.previewScroller.scrollTo(0)) this.clearCache();
		} else if (matchesKey(data, Key.end)) {
			if (this.previewScroller.scrollTo(this.previewScroller.maxOffset)) this.clearCache();
		}
	}

	private openPreview(): void {
		const row = this.legendRows[this.navigator.selected];
		if (row === undefined || row.type !== "category") return;
		this.previewRow = row;
		this.cachedPreviewEntries = undefined;
		this.previewLines = undefined;
		this.previewWrapWidth = undefined;
		this.previewScroller.reset();
		this.clearCache();
	}

	private closePreview(): void {
		this.previewRow = undefined;
		this.cachedPreviewEntries = undefined;
		this.previewLines = undefined;
		this.previewWrapWidth = undefined;
		this.clearCache();
	}

	/** Scrollable chronological content stream for one category. */
	private renderPreview(width: number, terminalRows: number, row: CategoryLegendRow): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const body = this.previewBodyLines(width, row);
		const descriptionLines = this.previewDescriptionLines(width, row);
		const descriptionLineCount = descriptionLines.length === 0 ? 0 : descriptionLines.length + 1;
		const viewport = calculateViewport(
			body.length,
			terminalRows,
			PREVIEW_FIXED_LINE_COUNT,
			descriptionLineCount,
		);
		this.previewScroller.setExtent(body.length, viewport.visibleCount);

		const title = theme.fg("accent", theme.bold(normalizeInlineText(row.category.label)));
		const percent = this.legendPercent(row.category.tokens);
		const meta = theme.fg(
			"muted",
			`${formatTokens(row.category.tokens)}${percent === "" ? "" : ` · ${percent}`} `,
		);
		const lines: string[] = [border, "", spreadLine(title, meta, width), ""];

		const start = this.previewScroller.offset;
		for (let index = start; index < start + viewport.visibleCount; index++) lines.push(body[index] ?? "");

		if (viewport.showScroll) {
			lines.push(
				fitLine(theme.fg("dim", `${BODY_INDENT}(${this.previewScroller.visibleEnd}/${body.length})`), width),
			);
		}
		if (descriptionLines.length > 0) lines.push("", ...descriptionLines);
		lines.push("");
		lines.push(
			fitLine(
				hintRow(theme, [
					[STEP_KEY_HINT, "Scroll"],
					["PgUp/PgDn", "Page"],
					["Esc", "Back"],
				]),
				width,
			),
		);
		lines.push("", border);
		return fitToTerminalHeight(lines, terminalRows, border);
	}

	/** Cached wrapped entry stream: bracket headers plus capped sanitized content. */
	private previewBodyLines(width: number, row: CategoryLegendRow): string[] {
		const wrapWidth = Math.max(10, width - BODY_INDENT.length * 2 - 1);
		if (this.previewLines !== undefined && this.previewWrapWidth === wrapWidth) return this.previewLines;
		const entries = this.previewEntries(row);
		const lines =
			entries.length === 0
				? [fitLine(this.theme.fg("muted", `${BODY_INDENT}No content captured for this category.`), width)]
				: entries.flatMap((entry, index) => [
						...(index === 0 ? [] : [""]),
						fitLine(`${BODY_INDENT}${this.entryHeader(entry)}`, width),
						...this.entryContentLines(entry, wrapWidth),
					]);
		this.previewLines = lines;
		this.previewWrapWidth = wrapWidth;
		return lines;
	}

	private previewEntries(row: CategoryLegendRow): readonly UsagePreviewEntry[] {
		this.cachedPreviewEntries ??= collectPreviewEntries(row.category);
		return this.cachedPreviewEntries;
	}

	/** Bracketed header: datetime, breadcrumbs, visible tokens and invisible reasoning. */
	private entryHeader(entry: UsagePreviewEntry): string {
		const theme = this.theme;
		const cells: string[] = [];
		if (entry.timestamp !== undefined) {
			cells.push(theme.fg("dim", `[${formatEntryTimestamp(entry.timestamp)}]`));
		}
		entry.breadcrumb.forEach((cell, index) => {
			const color: ThemeColor = index === 0 ? "mdHeading" : "muted";
			cells.push(
				`${theme.fg("dim", "[")}${theme.fg(color, normalizeInlineText(cell))}${theme.fg("dim", "]")}`,
			);
		});
		cells.push(theme.fg("dim", formatTokens(entry.visibleTokens ?? entry.tokens)));
		if (entry.invisibleReasoning !== undefined) {
			const { tokens, basis, encoded } = entry.invisibleReasoning;
			const marker = basis === "provider-reported" ? "≈" : "~";
			const label = encoded ? "Encoded" : "Reasoning";
			const total = (entry.visibleTokens ?? entry.tokens) + tokens;
			cells.push(
				theme.fg("dim", `+ ${label} ${marker}${formatTokens(tokens)} (${marker}${formatTokens(total)})`),
			);
		}
		return cells.join(" ");
	}

	/** Marker explanation, shown only when the preview contains reasoning metadata. */
	private previewDescriptionLines(width: number, row: CategoryLegendRow): string[] {
		if (row.rootId !== "agent-thinking-messages") return [];
		const hasInvisibleReasoning = this.previewEntries(row).some(
			(entry) => entry.invisibleReasoning !== undefined,
		);
		return hasInvisibleReasoning ? wrapDescriptionLines(this.theme, REASONING_DESCRIPTION, "dim", width) : [];
	}

	/** Sanitized, wrapped, per-entry-capped content lines indented under the header. */
	private entryContentLines(entry: UsagePreviewEntry, wrapWidth: number): string[] {
		const indent = BODY_INDENT.repeat(2);
		const lines: string[] = [];
		let hidden = 0;
		for (const paragraph of normalizePreviewText(entry.text).split("\n")) {
			const wrapped = wrapTextWithAnsi(paragraph, wrapWidth);
			for (const line of wrapped.length === 0 ? [""] : wrapped) {
				if (lines.length < PREVIEW_ENTRY_MAX_LINES) lines.push(line === "" ? "" : `${indent}${line}`);
				else hidden++;
			}
		}
		if (hidden === 0) return lines;
		return [...lines, `${indent}${this.theme.fg("dim", `… +${hidden} lines`)}`];
	}

	private clearCache(): void {
		this.cachedWidth = undefined;
		this.cachedTerminalRows = undefined;
		this.cachedLines = undefined;
	}
}

/** Entry-header datetime: DD-MM-YYYY HH:MM:SS in local time. */
function formatEntryTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (value: number) => `${value}`.padStart(2, "0");
	return (
		`${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}` +
		` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
	);
}

/** Marker distinguishing top-level occupancy, compacted data and nested breakdowns. */
function categoryMarker(categoryId: string, depth: number): string {
	if (depth > 0) return BREAKDOWN_MARKER;
	return categoryId === "compacted-data" ? COMPACTED_CELL : FULL_CELL;
}

function legendTokens(row: LegendRow): number {
	return row.type === "category" ? row.category.tokens : row.tokens;
}

/** Stable semantic theme colour for one category across map cells and legend markers. */
function categoryColor(categoryId: string | undefined): ThemeColor {
	switch (categoryId) {
		case "system-prompt":
		case "system-tools":
			return "mdHeading";
		case "custom-tools":
			return "accent";
		case "mcp-tools":
			return "mdLink";
		case "context-files":
			return "mdCodeBlock";
		case "skills":
			return "customMessageLabel";
		case "user-messages":
			return "syntaxString";
		case "agent-text-messages":
			return "syntaxFunction";
		case "agent-thinking-messages":
			return "thinkingXhigh";
		case "agent-tool-call-messages":
			return "syntaxKeyword";
		case "tool-output":
			return "toolOutput";
		case "extension-messages":
			return "syntaxType";
		case "compacted-data":
			return "thinkingHigh";
		default:
			return "muted";
	}
}

/** Compact token count: 951, 3.7k, 43.8k, 1M. */
export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	if (tokens < 1_000_000) return `${trimTrailingZero((tokens / 1_000).toFixed(1))}k`;
	return `${trimTrailingZero((tokens / 1_000_000).toFixed(1))}M`;
}

/** Percentage with one decimal below 10%: 0.4%, 4.2%, 96%. */
export function formatPercent(ratio: number): string {
	const percent = ratio * 100;
	if (percent >= 10) return `${Math.round(percent)}%`;
	return `${trimTrailingZero(percent.toFixed(1))}%`;
}

function trimTrailingZero(value: string): string {
	return value.endsWith(".0") ? value.slice(0, -2) : value;
}
