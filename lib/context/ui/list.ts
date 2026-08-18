/**
 * Presentation model shared by both views: flattened injection rows, list
 * navigation, preview scrolling and terminal-safe text normalization.
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";

import type { InjectionItem, InjectionSnapshot } from "../model.ts";

/** Every C0 and C1 control character; newlines are restored by the replacer. */
const CONTROL_CHARACTER = /\p{Cc}/gu;

/** One flattened list row derived from the snapshot hierarchy. */
export type InjectionRow =
	| { readonly kind: "group"; readonly label: string; readonly tokens: number; readonly depth: 0 }
	| {
			readonly kind: "item";
			readonly label: string;
			readonly tokens: number;
			/** One for items and two for constituent sub-items. */
			readonly depth: 1 | 2;
			/** Whether this row is the final sibling at its depth. */
			readonly isLast: boolean;
			/** Whether a depth-two row's parent has a following sibling. */
			readonly parentContinues?: boolean;
			/** Stable preview target id from the snapshot. */
			readonly itemId: string;
	  }
	| { readonly kind: "separator"; readonly label: ""; readonly tokens: 0; readonly depth: 0 }
	| { readonly kind: "total"; readonly label: "TOTAL"; readonly tokens: number; readonly depth: 0 };

/** Index snapshot items, including sub-items, by id for preview lookup. */
export function collectItemsById(snapshot: InjectionSnapshot): Map<string, InjectionItem> {
	const items = new Map<string, InjectionItem>();
	for (const group of snapshot.groups) {
		for (const item of group.items) {
			items.set(item.id, item);
			for (const child of item.children ?? []) items.set(child.id, child);
		}
	}
	return items;
}

/**
 * Normalize whitespace and remove terminal control sequences from raw preview
 * text, so nothing captured from a tool result can drive the terminal. Escape
 * sequences are removed whole; any remaining control character is dropped.
 */
export function normalizePreviewText(text: string): string {
	const normalized = stripTerminalSequences(text)
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replaceAll("\t", "    ");
	return normalized.replace(CONTROL_CHARACTER, (character) => (character === "\n" ? character : ""));
}

/** Sanitize dynamic text for one terminal line and collapse embedded whitespace. */
export function normalizeInlineText(text: string): string {
	return normalizePreviewText(text).replace(/\s+/g, " ").trim();
}

/** Flatten snapshot groups into rows separated from the non-selectable total. */
export function buildInjectionRows(snapshot: InjectionSnapshot): InjectionRow[] {
	const rows: InjectionRow[] = [];
	for (const group of snapshot.groups) {
		rows.push({ kind: "group", label: group.source.label, tokens: group.totalTokens, depth: 0 });
		group.items.forEach((item, itemIndex) => {
			const isLastItem = itemIndex === group.items.length - 1;
			rows.push({
				kind: "item",
				label: item.label,
				tokens: item.tokens,
				depth: 1,
				isLast: isLastItem,
				itemId: item.id,
			});
			const children = item.children ?? [];
			children.forEach((child, childIndex) => {
				rows.push({
					kind: "item",
					label: child.label,
					tokens: child.tokens,
					depth: 2,
					isLast: childIndex === children.length - 1,
					parentContinues: !isLastItem,
					itemId: child.id,
				});
			});
		});
	}
	rows.push({ kind: "separator", label: "", tokens: 0, depth: 0 });
	rows.push({ kind: "total", label: "TOTAL", tokens: snapshot.totalTokens, depth: 0 });
	return rows;
}

/**
 * Selection and scroll-window state over fixed rows. A trailing summary can
 * scroll without being included in selection navigation.
 */
export class ListNavigator {
	private readonly rowCount: number;
	private readonly selectableRowCount: number;
	private visibleCount: number;
	private selectedIndex = 0;
	private scrollOffset = 0;

	constructor(rowCount: number, visibleCount: number, selectableRowCount = rowCount) {
		this.rowCount = Math.max(0, rowCount);
		this.selectableRowCount = Math.min(this.rowCount, Math.max(0, selectableRowCount));
		this.visibleCount = Math.max(1, visibleCount);
	}

	get selected(): number {
		return this.selectedIndex;
	}

	get selectableCount(): number {
		return this.selectableRowCount;
	}

	get offset(): number {
		return this.scrollOffset;
	}

	get windowSize(): number {
		return Math.min(this.visibleCount, this.rowCount);
	}

	/** One-based final row currently visible, for a scroll counter. */
	get visibleEnd(): number {
		return Math.min(this.rowCount, this.scrollOffset + this.windowSize);
	}

	get hasOverflow(): boolean {
		return this.rowCount > this.visibleCount;
	}

	setVisibleCount(count: number): void {
		this.visibleCount = Math.max(1, count);
		this.ensureVisible();
	}

	moveBy(delta: number): boolean {
		return this.moveTo(this.selectedIndex + delta);
	}

	moveTo(index: number): boolean {
		if (this.selectableRowCount === 0) return false;
		const next = Math.min(this.selectableRowCount - 1, Math.max(0, index));
		if (next === this.selectedIndex) return false;
		this.selectedIndex = next;
		this.ensureVisible();
		return true;
	}

	page(direction: -1 | 1): boolean {
		return this.moveBy(direction * Math.max(1, this.visibleCount - 1));
	}

	private ensureVisible(): void {
		const maxOffset = Math.max(0, this.rowCount - this.visibleCount);
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + this.visibleCount) {
			this.scrollOffset = this.selectedIndex - this.visibleCount + 1;
		}

		const trailingRows = this.rowCount - this.selectedIndex - 1;
		if (this.selectedIndex === this.selectableRowCount - 1 && trailingRows < this.visibleCount) {
			this.scrollOffset = maxOffset;
		}
		this.scrollOffset = Math.min(maxOffset, Math.max(0, this.scrollOffset));
	}
}

/**
 * Scroll-only window over wrapped preview lines. The extent is re-declared each
 * render because wrapping depends on width; the offset is clamped to stay valid.
 */
export class PreviewScroller {
	private lineCount = 0;
	private visibleCount = 1;
	private offsetValue = 0;

	get offset(): number {
		return this.offsetValue;
	}

	get windowSize(): number {
		return Math.min(this.visibleCount, this.lineCount);
	}

	/** One-based final line currently visible, for a progress counter. */
	get visibleEnd(): number {
		return Math.min(this.lineCount, this.offsetValue + this.windowSize);
	}

	get hasOverflow(): boolean {
		return this.lineCount > this.visibleCount;
	}

	get maxOffset(): number {
		return Math.max(0, this.lineCount - this.visibleCount);
	}

	setExtent(lineCount: number, visibleCount: number): void {
		this.lineCount = Math.max(0, lineCount);
		this.visibleCount = Math.max(1, visibleCount);
		this.offsetValue = Math.min(this.maxOffset, this.offsetValue);
	}

	scrollBy(delta: number): boolean {
		return this.scrollTo(this.offsetValue + delta);
	}

	scrollTo(offset: number): boolean {
		const next = Math.min(this.maxOffset, Math.max(0, offset));
		if (next === this.offsetValue) return false;
		this.offsetValue = next;
		return true;
	}

	page(direction: -1 | 1): boolean {
		return this.scrollBy(direction * Math.max(1, this.visibleCount - 1));
	}

	reset(): void {
		this.offsetValue = 0;
	}
}
