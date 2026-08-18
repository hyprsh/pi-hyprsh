/**
 * Compact framing for tool calls.
 *
 * pi frames every tool call in a padded box: a separator line, a blank tinted
 * line, the call, the result, and a second blank tinted line. Taking over the
 * render shell drops the two blank lines, so a read is three lines — separator,
 * reason, call — instead of five. The one-column indent and the pending /
 * success / error tint are re-applied here, so the block still reads as one
 * unit and still shows its status.
 *
 * The call line also ends in the time the call took, measured from the frame
 * that started execution to the frame that carried the final result. Calls
 * replayed from a session are not timed, since their execution happened in
 * another process.
 */

import { keyHint, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";

/** One column each side, the padding pi's own box adds. */
const PAD = 1;
/** Same budget as pi's own fallback result rendering. */
const PREVIEW_LINES = 10;

type Tint = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

/** Namespaced, because the wrapped tool renders with the same state object. */
interface Timing {
	compactStartedAt?: number;
	compactEndedAt?: number;
}

function tintFor(isPartial: boolean, isError: boolean): Tint {
	if (isPartial) return "toolPendingBg";
	return isError ? "toolErrorBg" : "toolSuccessBg";
}

/**
 * Indents and tints whatever the wrapped renderer produced, and appends the
 * suffix to its last non-empty line when there is room for it.
 */
class Framed implements Component {
	inner: Component | undefined;
	private theme: Theme | undefined;
	private tint: Tint = "toolPendingBg";
	private suffix = "";

	setFrame(theme: Theme, tint: Tint, suffix: string): void {
		this.theme = theme;
		this.tint = tint;
		this.suffix = suffix;
	}

	setInner(component: Component | undefined): void {
		this.inner = component;
	}

	invalidate(): void {
		this.inner?.invalidate?.();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const contentWidth = Math.max(1, width - PAD * 2);
		const lines = this.inner?.render(contentWidth) ?? [];
		if (lines.length === 0 || !theme) return lines;

		const suffixed = this.suffix ? appendSuffix(lines, this.suffix, contentWidth) : lines;
		return suffixed.map((line) => {
			const padding = " ".repeat(Math.max(0, width - PAD - visibleWidth(line)));
			return theme.bg(this.tint, " ".repeat(PAD) + line + padding);
		});
	}
}

/** Renderers pad their lines out to the width they were given, so the last one is trimmed first. */
function appendSuffix(lines: string[], suffix: string, width: number): string[] {
	const index = lines.findLastIndex((line) => visibleWidth(line.trimEnd()) > 0);
	const line = index < 0 ? undefined : lines[index]?.trimEnd();
	if (line === undefined || visibleWidth(line) + visibleWidth(suffix) > width) return lines;
	return lines.map((current, i) => (i === index ? line + suffix : current));
}

/** Timed only when the call was seen running, so replayed history stays unlabelled. */
function elapsed(state: Timing, executionStarted: boolean, isPartial: boolean): number | undefined {
	if (isPartial) {
		if (executionStarted) state.compactStartedAt ??= Date.now();
		return undefined;
	}
	if (state.compactStartedAt === undefined) return undefined;
	state.compactEndedAt ??= Date.now();
	return state.compactEndedAt - state.compactStartedAt;
}

/** Same shape as pi's own duration label. */
function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function textOutput(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

/**
 * Stands in for the fallback pi applies to tools without a result renderer,
 * which is internal to it and would otherwise render outside the frame.
 */
function fallbackResult(output: string, expanded: boolean, theme: Theme): Component | undefined {
	if (!output) return undefined;
	const lines = output.split("\n");
	const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES);
	const remaining = lines.length - shown.length;
	let text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return new Text(text, 0, 0);
}

/**
 * Wraps a tool so its call block renders without pi's padding lines. Call and
 * result rendering are delegated untouched; only the frame around them and the
 * duration on the call line are added.
 */
export function compact<TParams extends TSchema, TDetails, TState>(
	base: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	const baseRenderCall = base.renderCall;
	const baseRenderResult = base.renderResult;

	return {
		...base,
		renderShell: "self",

		renderCall(args, theme, context) {
			const frame = context.lastComponent instanceof Framed ? context.lastComponent : new Framed();
			const ms = elapsed(context.state as Timing, context.executionStarted, context.isPartial);
			const suffix = ms === undefined ? "" : theme.fg("muted", ` ${formatDuration(ms)}`);
			frame.setFrame(theme, tintFor(context.isPartial, context.isError), suffix);
			frame.setInner(
				baseRenderCall
					? baseRenderCall(args, theme, { ...context, lastComponent: frame.inner })
					: new Text(theme.fg("toolTitle", theme.bold(base.name)), 0, 0),
			);
			return frame;
		},

		renderResult(result, options, theme, context) {
			const frame = context.lastComponent instanceof Framed ? context.lastComponent : new Framed();
			frame.setFrame(theme, tintFor(options.isPartial, context.isError), "");
			frame.setInner(
				baseRenderResult
					? baseRenderResult(result, options, theme, { ...context, lastComponent: frame.inner })
					: fallbackResult(textOutput(result.content), options.expanded, theme),
			);
			return frame;
		},
	};
}
