/**
 * todo — a task list for the model, shown above the editor.
 *
 * The model owns the list through one tool that always sends the whole thing;
 * the panel and `/todos` only read it. State lives in the session itself: every
 * result carries the post-call snapshot, and the list is replayed from the
 * session branch on start, so it survives /reload, compaction and forks.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compact } from "../compact/index.ts";
import { MAX_TODOS, parseTodos, replayTodos, STATUSES, TOOL_NAME, type Todo } from "./model.ts";
import { formatList, formatResult, panelLines } from "./render.ts";

const WIDGET_KEY = "hyprsh-todo";

const TODO = Type.Object({
	id: Type.String({ description: "Stable identifier, reused across calls to update the same task." }),
	text: Type.String({ description: "The task in one imperative line." }),
	status: Type.Unsafe<Todo["status"]>({
		type: "string",
		enum: [...STATUSES],
		description: "pending, in_progress (at most one) or completed.",
	}),
});

export function registerTodo(pi: ExtensionAPI): void {
	let todos: Todo[] = [];
	let requestRender: () => void = () => {};

	/** Installed once per session; the component reads the live list on every paint. */
	function installPanel(ctx: ExtensionContext): void {
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
						return panelLines(todos, theme, width);
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	}

	function restore(ctx: ExtensionContext): void {
		todos = replayTodos(ctx.sessionManager.getBranch());
		requestRender();
	}

	pi.on("session_start", async (_event, ctx) => {
		installPanel(ctx);
		restore(ctx);
	});

	// A different branch is a different list.
	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
	});

	pi.registerTool(
		compact({
			name: TOOL_NAME,
			label: "Todo",
			description:
				"Track the plan for a multi-step task as a visible list. Every call sends the complete list and replaces the previous one, so include unchanged tasks as they were. The list is shown to the user above their input.",
			promptSnippet: "Keep a visible plan for multi-step work with the todo tool.",
			promptGuidelines: [
				"Use todo for work with several distinct steps; skip it for a single edit or question.",
				"Send the whole list on every call, keep exactly one task in_progress, and mark it completed before starting the next.",
			],
			parameters: Type.Object({
				todos: Type.Array(TODO, {
					maxItems: MAX_TODOS,
					description: "The complete task list, in the order it should be worked through.",
				}),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				todos = parseTodos(params.todos);
				requestRender();

				return {
					content: [{ type: "text", text: formatResult(todos) }],
					details: { todos },
				};
			},
		}),
	);

	pi.registerCommand("todos", {
		description: "Show the current todo list",
		handler: async (_args, ctx) => {
			const text = formatList(todos);
			if (ctx.hasUI) ctx.ui.notify(text);
			else process.stdout.write(`${text}\n`);
		},
	});
}
