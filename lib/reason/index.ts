/**
 * The `reasoning` argument on tool calls.
 *
 * Every built-in tool gains a required `reasoning` argument, stripped again
 * before the call is executed or rendered, so execution, result rendering,
 * diffs, syntax highlighting and ctrl+o expansion stay native. The reason
 * itself is shown by lib/compact, on the header line above the call.
 *
 * Only tools the live registry still reports as built-in are wrapped, so an
 * extension that owns `grep` or `find` keeps owning it.
 */

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TObject, TSchema } from "typebox";
import { Type } from "typebox";
import { compact } from "../compact/index.ts";

const REASONING = Type.String({
	description:
		"Goal behind this call, at most 12 words. State the intent or what you expect to find, never a restatement of the path, pattern or command, which are already displayed. Present tense, no trailing period.",
});

const GUIDELINE =
	"Every built-in tool call needs reasoning: the goal behind the call, not a restatement of its arguments.";

/** Reasoning leads the schema so it streams in before the arguments it explains. */
function withReasoning(parameters: TObject): TObject {
	return Type.Object({ reasoning: REASONING, ...parameters.properties });
}

function splitReasoning(args: unknown): { reason: string; rest: unknown } {
	if (!args || typeof args !== "object") return { reason: "", rest: args };
	const { reasoning, ...rest } = args as Record<string, unknown>;
	return { reason: typeof reasoning === "string" ? reasoning : "", rest };
}

/**
 * The wrapped schema is only known at runtime, so the delegated arguments are
 * asserted back into the built-in tool's parameter type. They are that type:
 * the wrapper adds one property and strips it again before delegating.
 */
export function withReason<TParams extends TObject, TDetails, TState>(
	base: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TSchema, TDetails, TState> {
	const baseRenderCall = base.renderCall;
	const baseRenderResult = base.renderResult;
	return {
		...base,
		parameters: withReasoning(base.parameters),
		promptGuidelines: [...(base.promptGuidelines ?? []), GUIDELINE],
		execute(toolCallId, params, signal, onUpdate, ctx) {
			const rest = splitReasoning(params).rest as Static<TParams>;
			return base.execute.call(base, toolCallId, rest, signal, onUpdate, ctx);
		},
		/** Untouched native call rendering; only the delegated arguments are unwrapped. */
		renderCall:
			baseRenderCall &&
			((args, theme, context) => {
				const delegated = splitReasoning(args).rest as Static<TParams>;
				return baseRenderCall(delegated, theme, { ...context, args: delegated });
			}),
		/** Untouched native result rendering; only the delegated arguments are unwrapped. */
		renderResult:
			baseRenderResult &&
			((result, options, theme, context) =>
				baseRenderResult(result, options, theme, {
					...context,
					args: splitReasoning(context.args).rest as Static<TParams>,
				})),
	};
}

/** Built-in tools this feature wraps, keyed by the name they are registered under. */
const REGISTRARS: Record<string, (pi: ExtensionAPI, cwd: string) => void> = {
	read: (pi, cwd) => pi.registerTool(compact(withReason(createReadToolDefinition(cwd)))),
	write: (pi, cwd) => pi.registerTool(compact(withReason(createWriteToolDefinition(cwd)))),
	edit: (pi, cwd) => pi.registerTool(compact(withReason(createEditToolDefinition(cwd)))),
	bash: (pi, cwd) => pi.registerTool(compact(withReason(createBashToolDefinition(cwd)))),
	grep: (pi, cwd) => pi.registerTool(compact(withReason(createGrepToolDefinition(cwd)))),
	find: (pi, cwd) => pi.registerTool(compact(withReason(createFindToolDefinition(cwd)))),
	ls: (pi, cwd) => pi.registerTool(compact(withReason(createLsToolDefinition(cwd)))),
};

export function registerReason(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		for (const tool of pi.getAllTools()) {
			if (tool.sourceInfo.source !== "builtin") continue;
			REGISTRARS[tool.name]?.(pi, ctx.cwd);
		}
	});
}
