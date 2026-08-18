/**
 * `/context injections`: the hidden parts of the context — base prompt, tool
 * definitions, skills, memory files and extension additions — as a hierarchy
 * with an Enter-opened raw preview.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { InjectionItem, InjectionSnapshot } from "../model.ts";
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
import {
	buildInjectionRows,
	collectItemsById,
	type InjectionRow,
	ListNavigator,
	normalizeInlineText,
	normalizePreviewText,
	PreviewScroller,
} from "./list.ts";

const LIST_FIXED_LINE_COUNT = 10;
const PREVIEW_FIXED_LINE_COUNT = 8;
const LIST_DESCRIPTION = "Injections into the model context, with token estimates.";
const CURSOR_COLUMN_WIDTH = 2;
const MAX_TOKEN_VALUE_COLUMN = 54;
const TOKEN_LEADER_GAP = 4;

type ContentRow = Exclude<InjectionRow, { readonly kind: "separator" }>;

/** Everything the injections view renders. */
export interface InjectionsViewInput {
	readonly snapshot: InjectionSnapshot;
	readonly degradedReason?: string;
}

/** Open the injections view as a fullscreen overlay. */
export async function showInjectionsView(
	context: ExtensionCommandContext,
	input: InjectionsViewInput,
): Promise<void> {
	await context.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const view = new InjectionsView(theme, input, done, () => tui.terminal.rows);
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

class InjectionsView {
	private readonly theme: Theme;
	private readonly input: InjectionsViewInput;
	private readonly done: (result: undefined) => void;
	private readonly getTerminalRows: () => number;
	private readonly rows: InjectionRow[];
	private readonly navigator: ListNavigator;
	private readonly itemsById: Map<string, InjectionItem>;
	private readonly previewScroller = new PreviewScroller();
	private previewItem: InjectionItem | undefined;
	private previewLines: string[] | undefined;
	private previewWrapWidth: number | undefined;
	private cachedWidth: number | undefined;
	private cachedTerminalRows: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		theme: Theme,
		input: InjectionsViewInput,
		done: (result: undefined) => void,
		getTerminalRows: () => number = () => process.stdout.rows ?? DEFAULT_TERMINAL_ROWS,
	) {
		this.theme = theme;
		this.input = input;
		this.done = done;
		this.getTerminalRows = getTerminalRows;
		this.rows = buildInjectionRows(input.snapshot);
		// The trailing separator and total scroll with the list but are not selectable.
		this.navigator = new ListNavigator(this.rows.length, 1, this.rows.length - 2);
		this.itemsById = collectItemsById(input.snapshot);
	}

	handleInput(data: string): void {
		if (this.previewItem !== undefined) {
			this.handlePreviewInput(data);
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.enter)) {
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
			if (this.navigator.moveTo(this.rows.length - 1)) this.clearCache();
		}
	}

	render(width: number): string[] {
		const terminalRows = normalizeTerminalRows(this.getTerminalRows());
		if (
			this.cachedLines !== undefined &&
			this.cachedWidth === width &&
			this.cachedTerminalRows === terminalRows
		) {
			return this.cachedLines;
		}
		const lines =
			this.previewItem === undefined
				? this.renderList(width, terminalRows)
				: this.renderPreview(width, terminalRows, this.previewItem);
		this.cachedWidth = width;
		this.cachedTerminalRows = terminalRows;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.clearCache();
	}

	// === List ===

	private renderList(width: number, terminalRows: number): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const title = theme.fg("accent", theme.bold("Context Injections"));
		const warningLines = this.degradedWarningLines(width);
		const descriptionLines = this.descriptionLines(width);
		const extraLineCount = warningLines.length + descriptionLines.length - 1;
		const viewport = calculateViewport(this.rows.length, terminalRows, LIST_FIXED_LINE_COUNT, extraLineCount);
		this.navigator.setVisibleCount(viewport.visibleCount);

		const lines: string[] = [border, "", fitLine(title, width), "", ...warningLines];
		const listLines = this.listLines(width);
		lines.push(...listLines);
		if (viewport.showScroll) lines.push(this.scrollLine(width));
		for (let pad = 0; pad < viewport.visibleCount - listLines.length; pad++) lines.push("");
		lines.push("", ...descriptionLines, "");
		lines.push(
			fitLine(
				hintRow(theme, [
					[STEP_KEY_HINT, "Navigate"],
					["Enter", "Preview"],
					["Esc", "Close"],
				]),
				width,
			),
		);
		lines.push("", border);
		return fitToTerminalHeight(lines, terminalRows, border);
	}

	/** The current hierarchy viewport against one stable value column. */
	private listLines(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const contentWidth = Math.max(1, width - CURSOR_COLUMN_WIDTH);
		const valueColumn = this.valueColumn(contentWidth);
		const start = this.navigator.offset;
		for (let index = start; index < start + this.navigator.windowSize; index++) {
			const row = this.rows[index];
			if (row === undefined) break;
			if (row.kind === "separator") {
				lines.push("");
				continue;
			}
			const selected = row.kind !== "total" && index === this.navigator.selected;
			const cursor = selected ? theme.fg("accent", "→ ") : BODY_INDENT;
			lines.push(fitLine(`${cursor}${this.injectionLine(row, valueColumn, contentWidth, selected)}`, width));
		}
		return lines;
	}

	/** The earliest useful shared value column, capped on wide terminals. */
	private valueColumn(width: number): number {
		const contentRows = this.rows.filter((row): row is ContentRow => row.kind !== "separator");
		const labelWidth = Math.max(1, ...contentRows.map((row) => visibleWidth(this.plainRowLabel(row))));
		const tokenWidth = Math.max(1, ...contentRows.map((row) => formatCount(row.tokens).length));
		const ideal = Math.min(MAX_TOKEN_VALUE_COLUMN, labelWidth + TOKEN_LEADER_GAP);
		return Math.max(1, Math.min(ideal, width - tokenWidth));
	}

	/** One hierarchy row with dim leaders and a full token estimate. */
	private injectionLine(row: ContentRow, valueColumn: number, width: number, selected: boolean): string {
		const left = fitLine(this.styledRowLabel(row, selected), Math.max(1, valueColumn - 1));
		const leader = leaderLine(this.theme, valueColumn - visibleWidth(left));
		const value = formatCount(row.tokens);
		const tokens =
			row.kind === "total"
				? this.theme.bold(this.theme.fg("text", value))
				: this.theme.fg(selected ? "accent" : "muted", value);
		return fitLine(`${left}${leader}${tokens}`, width);
	}

	/** Unstyled hierarchy label, keeping the value column stable while scrolling. */
	private plainRowLabel(row: ContentRow): string {
		const label = normalizeInlineText(row.label);
		return row.kind === "item" ? `${treePrefix(row)}${label}` : label;
	}

	/** Themed hierarchy label with connectors intentionally dim even on selection. */
	private styledRowLabel(row: ContentRow, selected: boolean): string {
		const theme = this.theme;
		const label = normalizeInlineText(row.label);
		if (row.kind === "group" || row.kind === "total") {
			return theme.bold(theme.fg(selected ? "accent" : "text", label));
		}
		const prefix = theme.fg("dim", treePrefix(row));
		const color = selected ? "accent" : row.depth === 1 ? "muted" : "dim";
		return `${prefix}${theme.fg(color, label)}`;
	}

	private scrollLine(width: number): string {
		if (!this.navigator.hasOverflow) return fitLine("", width);
		return fitLine(
			this.theme.fg(
				"dim",
				`${BODY_INDENT}(${this.navigator.selected + 1}/${this.navigator.selectableCount})`,
			),
			width,
		);
	}

	/** Wrapped reason placed below the header when capture was incomplete. */
	private degradedWarningLines(width: number): string[] {
		if (this.input.degradedReason === undefined) return [];
		const reason = normalizeInlineText(this.input.degradedReason);
		return wrapTextWithAnsi(this.theme.fg("warning", `${BODY_INDENT}${reason}`), width);
	}

	private descriptionLines(width: number): string[] {
		return wrapDescriptionLines(this.theme, LIST_DESCRIPTION, "dim", width);
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
		const row = this.rows[this.navigator.selected];
		if (row?.kind !== "item") return;
		const item = this.itemsById.get(row.itemId);
		if (item === undefined) return;
		this.previewItem = item;
		this.previewLines = undefined;
		this.previewWrapWidth = undefined;
		this.previewScroller.reset();
		this.clearCache();
	}

	private closePreview(): void {
		this.previewItem = undefined;
		this.previewLines = undefined;
		this.previewWrapWidth = undefined;
		this.clearCache();
	}

	private renderPreview(width: number, terminalRows: number, item: InjectionItem): string[] {
		const theme = this.theme;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const wrapped = this.getPreviewLines(width, item);
		const viewport = calculateViewport(wrapped.length, terminalRows, PREVIEW_FIXED_LINE_COUNT);
		this.previewScroller.setExtent(wrapped.length, viewport.visibleCount);

		const title = theme.fg("accent", theme.bold(normalizeInlineText(item.label)));
		const meta = theme.fg(
			"muted",
			`${normalizeInlineText(item.source.label)} · ${formatCount(item.tokens)} tokens `,
		);
		const lines: string[] = [border, "", spreadLine(title, meta, width), ""];

		const start = this.previewScroller.offset;
		for (let index = start; index < start + viewport.visibleCount; index++) lines.push(wrapped[index] ?? "");

		if (viewport.showScroll) {
			lines.push(
				fitLine(
					theme.fg("dim", `${BODY_INDENT}(${this.previewScroller.visibleEnd}/${wrapped.length})`),
					width,
				),
			);
		}
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

	private getPreviewLines(width: number, item: InjectionItem): string[] {
		const wrapWidth = Math.max(10, width - BODY_INDENT.length - 1);
		if (this.previewLines !== undefined && this.previewWrapWidth === wrapWidth) return this.previewLines;
		const lines: string[] = [];
		for (const paragraph of normalizePreviewText(item.text).split("\n")) {
			const wrapped = wrapTextWithAnsi(paragraph, wrapWidth);
			if (wrapped.length === 0) {
				lines.push("");
				continue;
			}
			for (const line of wrapped) lines.push(`${BODY_INDENT}${line}`);
		}
		this.previewLines = lines;
		this.previewWrapWidth = wrapWidth;
		return lines;
	}

	private clearCache(): void {
		this.cachedWidth = undefined;
		this.cachedTerminalRows = undefined;
		this.cachedLines = undefined;
	}
}

/** Tree branch and ancestor continuation prefix for one item row. */
function treePrefix(row: Extract<InjectionRow, { readonly kind: "item" }>): string {
	const branch = row.isLast ? "└─ " : "├─ ";
	if (row.depth === 1) return branch;
	return `${row.parentContinues === true ? "│  " : "   "}${branch}`;
}

/** Full token count with thousands separators. */
function formatCount(tokens: number): string {
	return tokens.toLocaleString("en-US");
}
