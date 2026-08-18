/**
 * Reason line on built-in tool calls.
 *
 * Every built-in tool gains a required `reasoning` argument, rendered as one
 * line above pi's own call rendering. Nothing else changes: execution, result
 * rendering, diffs, syntax highlighting and ctrl+o expansion stay native, so
 * the reason is added without taking anything away.
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
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { Static, TObject, TSchema } from "typebox";
import { Type } from "typebox";

const REASONING = Type.String({
	description:
		"Goal behind this call, at most 12 words. State the intent or what you expect to find, never a restatement of the path, pattern or command, which are already displayed. Present tense, no trailing period.",
});

const GUIDELINE =
	"Every built-in tool call needs reasoning: the goal behind the call, not a restatement of its arguments.";

/**
 * Own component rather than a Container so an absent reason renders no line at
 * all, and so pi's own call component keeps being the instance it returned.
 */
class ReasonCall implements Component {
	private readonly line = new Text("", 0, 0);
	private reason = "";
	inner: Component | undefined;

	setReason(reason: string, theme: Theme): void {
		this.reason = reason;
		if (reason) this.line.setText(theme.italic(theme.fg("thinkingText", reason)));
	}

	setInner(component: Component | undefined): void {
		this.inner = component;
	}

	invalidate(): void {
		this.line.invalidate();
		this.inner?.invalidate?.();
	}

	render(width: number): string[] {
		const lines = this.reason ? this.line.render(width) : [];
		return this.inner ? [...lines, ...this.inner.render(width)] : lines;
	}
}

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
function wrapWithReason<TParams extends TObject, TDetails, TState>(
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
		renderCall:
			baseRenderCall &&
			((args, theme, context) => {
				const component =
					context.lastComponent instanceof ReasonCall ? context.lastComponent : new ReasonCall();
				const { reason, rest } = splitReasoning(args);
				const delegated = rest as Static<TParams>;
				component.setReason(reason, theme);
				component.setInner(
					baseRenderCall(delegated, theme, {
						...context,
						args: delegated,
						lastComponent: component.inner,
					}),
				);
				return component;
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
	read: (pi, cwd) => pi.registerTool(wrapWithReason(createReadToolDefinition(cwd))),
	write: (pi, cwd) => pi.registerTool(wrapWithReason(createWriteToolDefinition(cwd))),
	edit: (pi, cwd) => pi.registerTool(wrapWithReason(createEditToolDefinition(cwd))),
	bash: (pi, cwd) => pi.registerTool(wrapWithReason(createBashToolDefinition(cwd))),
	grep: (pi, cwd) => pi.registerTool(wrapWithReason(createGrepToolDefinition(cwd))),
	find: (pi, cwd) => pi.registerTool(wrapWithReason(createFindToolDefinition(cwd))),
	ls: (pi, cwd) => pi.registerTool(wrapWithReason(createLsToolDefinition(cwd))),
};

export function registerReason(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		for (const tool of pi.getAllTools()) {
			if (tool.sourceInfo.source !== "builtin") continue;
			REGISTRARS[tool.name]?.(pi, ctx.cwd);
		}
	});
}
