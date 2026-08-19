/**
 * Rendering for the todo list: the panel above the editor, the plain text form
 * `/todos` prints, and the text a `todo` call reports back.
 *
 * The panel never grows past MAX_PANEL_LINES. Past that budget completed rows
 * are dropped first and unfinished ones last, and a trailing line says what was
 * hidden.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { completedCount, isFinished, isResolved, type Todo, type TodoStatus } from "./model.ts";

/** Heading and overflow line included. */
export const MAX_PANEL_LINES = 12;

const GLYPHS: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "▶",
	completed: "✔",
	skipped: "⊘",
};

/** A skipped row is only worth keeping because it carries why. */
function rowText(todo: Todo): string {
	return todo.reason ? `${todo.text} — ${todo.reason}` : todo.text;
}

function heading(todos: readonly Todo[]): string {
	return `Todos (${completedCount(todos)}/${todos.length})`;
}

/** Unfinished work keeps its rows; settled rows yield first. */
function selectRows(todos: readonly Todo[], budget: number): { shown: Todo[]; hidden: Todo[] } {
	if (budget >= todos.length) return { shown: [...todos], hidden: [] };

	const keep = new Set<Todo>();
	for (const todo of todos) {
		if (keep.size >= budget) break;
		if (!isResolved(todo)) keep.add(todo);
	}
	for (const todo of todos) {
		if (keep.size >= budget) break;
		if (isResolved(todo)) keep.add(todo);
	}
	return {
		shown: todos.filter((todo) => keep.has(todo)),
		hidden: todos.filter((todo) => !keep.has(todo)),
	};
}

function overflowLine(hidden: readonly Todo[]): string {
	const counts: string[] = [];
	const completed = hidden.filter((todo) => todo.status === "completed").length;
	const running = hidden.filter((todo) => todo.status === "in_progress").length;
	const pending = hidden.filter((todo) => todo.status === "pending").length;
	const skipped = hidden.filter((todo) => todo.status === "skipped").length;
	if (completed > 0) counts.push(`${completed} completed`);
	if (running > 0) counts.push(`${running} in progress`);
	if (pending > 0) counts.push(`${pending} pending`);
	if (skipped > 0) counts.push(`${skipped} skipped`);
	return `+${hidden.length} more (${counts.join(", ")})`;
}

function panelRow(todo: Todo, theme: Theme): string {
	const glyph = GLYPHS[todo.status];
	if (todo.status === "completed") {
		return theme.fg("success", ` ${glyph} `) + theme.fg("dim", theme.strikethrough(todo.text));
	}
	if (todo.status === "skipped") {
		return theme.fg("warning", ` ${glyph} `) + theme.fg("dim", rowText(todo));
	}
	if (todo.status === "in_progress") {
		return theme.fg("accent", ` ${glyph} `) + theme.bold(theme.fg("text", todo.text));
	}
	return theme.fg("dim", ` ${glyph} `) + theme.fg("muted", todo.text);
}

/** Empty while there is nothing left to do, so the panel disappears on its own. */
export function panelLines(todos: readonly Todo[], theme: Theme, width: number): string[] {
	if (isFinished(todos)) return [];

	// One line goes to the heading, and one more to the overflow note when it is needed.
	const rowBudget = MAX_PANEL_LINES - 1;
	const { shown, hidden } = selectRows(todos, todos.length <= rowBudget ? rowBudget : rowBudget - 1);

	const lines = [theme.bold(theme.fg("toolTitle", heading(todos)))];
	for (const todo of shown) lines.push(panelRow(todo, theme));
	if (hidden.length > 0) lines.push(theme.fg("dim", overflowLine(hidden)));
	return lines.map((line) => truncateToWidth(line, width));
}

export function formatList(todos: readonly Todo[]): string {
	if (todos.length === 0) return "No todos yet. Ask the agent to add some!";
	const rows = todos.map((todo) => ` ${GLYPHS[todo.status]} ${rowText(todo)}`);
	return [heading(todos), ...rows].join("\n");
}

/** The tool speaks to the model, so an emptied list is a state and not an invitation. */
export function formatResult(todos: readonly Todo[]): string {
	return todos.length === 0 ? "Todo list cleared." : formatList(todos);
}
