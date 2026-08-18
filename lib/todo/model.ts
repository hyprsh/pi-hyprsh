/**
 * The todo list itself: shape, validation and session replay.
 *
 * A `todo` call always carries the whole list, so a call is a full replacement
 * and the last call on the session branch is the current state. That is what
 * makes the list survive /reload and compaction without a single disk write.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const TOOL_NAME = "todo";
export const MAX_TODOS = 50;
export const STATUSES = ["pending", "in_progress", "completed"] as const;

export type TodoStatus = (typeof STATUSES)[number];

export interface Todo {
	id: string;
	text: string;
	status: TodoStatus;
}

function isStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/** Throws with a message the model can act on; the tool turns it into an error result. */
export function parseTodos(input: unknown): Todo[] {
	if (!Array.isArray(input)) throw new Error("todos must be an array");
	if (input.length > MAX_TODOS) throw new Error(`todos must hold at most ${MAX_TODOS} entries`);

	const todos: Todo[] = [];
	const seen = new Set<string>();
	for (const raw of input) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("each todo must be an object");
		const entry = raw as Record<string, unknown>;

		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (!id) throw new Error("each todo needs a non-empty id");
		if (seen.has(id)) throw new Error(`duplicate todo id: ${id}`);
		seen.add(id);

		const text = typeof entry.text === "string" ? entry.text.replace(/\s+/g, " ").trim() : "";
		if (!text) throw new Error(`todo ${id} needs non-empty text`);

		if (!isStatus(entry.status)) throw new Error(`todo ${id} needs status ${STATUSES.join(", ")}`);

		todos.push({ id, text, status: entry.status });
	}

	if (todos.filter((todo) => todo.status === "in_progress").length > 1) {
		throw new Error("at most one todo may be in_progress");
	}
	return todos;
}

export function completedCount(todos: readonly Todo[]): number {
	return todos.filter((todo) => todo.status === "completed").length;
}

/** A finished list has nothing left to show, so the panel gets out of the way. */
export function isFinished(todos: readonly Todo[]): boolean {
	return todos.length === 0 || completedCount(todos) === todos.length;
}

/** The snapshot a tool result carries, read back defensively on replay. */
function readSnapshot(details: unknown): Todo[] | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	try {
		return parseTodos((details as { todos?: unknown }).todos);
	} catch {
		return undefined;
	}
}

/**
 * The list as of the newest `todo` result on the branch.
 *
 * Entries are read straight from the session file, so calls that compaction
 * summarized away still count and the list outlives both /reload and /compact.
 */
export function replayTodos(entries: readonly SessionEntry[]): Todo[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== TOOL_NAME || message.isError) continue;
		const todos = readSnapshot(message.details);
		if (todos) return todos;
	}
	return [];
}
