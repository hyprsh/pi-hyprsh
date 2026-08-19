/**
 * Compact framing and the header line on tool calls.
 *
 * pi frames every tool call in a padded box: a separator line, a blank tinted
 * line, the call, the result, and a second blank tinted line. Taking over the
 * render shell drops the two blank lines, so a read is three lines — separator,
 * header, call — instead of five. The one-column indent and the pending /
 * success / error tint are re-applied here, so the block still reads as one
 * unit and still shows its status.
 *
 * Above the tool's own call rendering sits one header line:
 *
 *     [bash] Confirm the editor component is free -> 0.3s done
 *     $ rg -n setEditorComponent lib index.ts
 *
 * The tool name, the `reasoning` argument added by lib/reason, and the state of
 * the call. The duration is measured around `execute` itself, so it is the real
 * time spent and does not depend on when the row was repainted. Calls replayed
 * from a session never ran in this process, so they carry no state at all.
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
	compactMs?: number;
}

/**
 * Durations handed from `execute` to the first render that follows it.
 *
 * A render moves the value onto the row's own state, so the map only holds
 * calls that have not been painted yet. The cap covers the case where that
 * render never comes, such as a non-TUI host.
 */
const DURATIONS = new Map<string, number>();
const MAX_PENDING_DURATIONS = 64;

/**
 * Calls whose `execute` has not returned yet, which is what separates a running
 * call from one replayed out of a session file: both lack a duration, only the
 * running one is in here.
 */
const RUNNING = new Set<string>();

function recordDuration(toolCallId: string, ms: number): void {
	if (DURATIONS.size >= MAX_PENDING_DURATIONS) {
		const oldest = DURATIONS.keys().next();
		if (!oldest.done) DURATIONS.delete(oldest.value);
	}
	DURATIONS.set(toolCallId, ms);
}

function tintFor(isPartial: boolean, isError: boolean): Tint {
	if (isPartial) return "toolPendingBg";
	return isError ? "toolErrorBg" : "toolSuccessBg";
}

/**
 * Puts the header above whatever the wrapped renderer produced, then indents
 * and tints the whole block. Result rows reuse it with an empty header.
 */
class Framed implements Component {
	inner: Component | undefined;
	private readonly header = new Text("", 0, 0);
	private hasHeader = false;
	private theme: Theme | undefined;
	private tint: Tint = "toolPendingBg";

	setFrame(theme: Theme, tint: Tint, header: string): void {
		this.theme = theme;
		this.tint = tint;
		this.hasHeader = header !== "";
		this.header.setText(header);
	}

	setInner(component: Component | undefined): void {
		this.inner = component;
	}

	invalidate(): void {
		this.header.invalidate();
		this.inner?.invalidate?.();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const contentWidth = Math.max(1, width - PAD * 2);
		const lines = [
			...(this.hasHeader ? this.header.render(contentWidth) : []),
			...(this.inner?.render(contentWidth) ?? []),
		];
		if (lines.length === 0 || !theme) return lines;

		return lines.map((line) => {
			const padding = " ".repeat(Math.max(0, width - PAD - visibleWidth(line)));
			return theme.bg(this.tint, " ".repeat(PAD) + line + padding);
		});
	}
}

/** Timed only when this process ran the call, so replayed history stays unlabelled. */
function elapsed(state: Timing, toolCallId: string): number | undefined {
	const recorded = DURATIONS.get(toolCallId);
	if (recorded !== undefined) {
		state.compactMs = recorded;
		DURATIONS.delete(toolCallId);
	}
	return state.compactMs;
}

/** Same shape as pi's own duration label. */
function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Empty for a replayed call: it neither runs here nor was timed here. */
function statusOf(state: Timing, toolCallId: string, isError: boolean): string {
	const ms = elapsed(state, toolCallId);
	if (ms !== undefined) return `-> ${formatDuration(ms)} ${isError ? "error" : "done"}`;
	return RUNNING.has(toolCallId) ? "-> running" : "";
}

/** The `reasoning` argument lib/reason adds; absent on a tool that is only compacted. */
function reasonOf(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const reasoning = (args as { reasoning?: unknown }).reasoning;
	return typeof reasoning === "string" ? reasoning.trim() : "";
}

function headerFor(name: string, args: unknown, status: string, theme: Theme): string {
	const reason = reasonOf(args);
	return [
		theme.fg("toolTitle", theme.bold(`[${name}]`)),
		...(reason ? [theme.italic(theme.fg("thinkingText", reason))] : []),
		...(status ? [theme.fg("muted", status)] : []),
	].join(" ");
}

/**
 * Drops a tool's own duration line, which the header already carries.
 *
 * pi's bash result rendering ends in `Took 0.0s`, added only when the render
 * state holds a start time. Clearing that field before delegating removes the
 * line without touching the output above it.
 */
export function withoutNativeDuration<TParams extends TSchema, TDetails, TState>(
	base: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	const baseRenderResult = base.renderResult;
	if (!baseRenderResult) return base;
	return {
		...base,
		renderResult(result, options, theme, context) {
			(context.state as { startedAt?: number }).startedAt = undefined;
			return baseRenderResult(result, options, theme, context);
		},
	};
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
 * Whether wrapped tools take over their own frame.
 *
 * Every tool this pack registers is wrapped at definition time, long before a
 * feature flag could be threaded to each call site, so the switch lives here
 * and index.ts sets it once before anything registers. Off, `compact` hands
 * the definition straight back and pi frames the call itself.
 */
let enabled = true;

export function configureCompact(on: boolean): void {
	enabled = on;
}

/**
 * Wraps a tool so its call block renders without pi's padding lines. Call and
 * result rendering are delegated untouched; only the frame around them and the
 * duration on the call line are added.
 */
export function compact<TParams extends TSchema, TDetails, TState>(
	base: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	if (!enabled) return base;

	const baseRenderCall = base.renderCall;
	const baseRenderResult = base.renderResult;

	return {
		...base,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const startedAt = Date.now();
			RUNNING.add(toolCallId);
			try {
				return await base.execute(toolCallId, params, signal, onUpdate, ctx);
			} finally {
				recordDuration(toolCallId, Date.now() - startedAt);
				RUNNING.delete(toolCallId);
			}
		},

		/** The header carries the tool name, so a tool without a call renderer needs no line of its own. */
		renderCall(args, theme, context) {
			const frame = context.lastComponent instanceof Framed ? context.lastComponent : new Framed();
			const status = statusOf(context.state as Timing, context.toolCallId, context.isError);
			frame.setFrame(
				theme,
				tintFor(context.isPartial, context.isError),
				headerFor(base.name, args, status, theme),
			);
			frame.setInner(
				baseRenderCall ? baseRenderCall(args, theme, { ...context, lastComponent: frame.inner }) : undefined,
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
