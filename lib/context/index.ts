/**
 * Context inspection: `/context usage` and `/context injections`.
 *
 * Ported from pi-context-view (MIT, Dmitry Makarov) and reduced to the two
 * views. The silent probe is not part of this port: the prompt, tools, skills
 * and memory files are read on demand, and what other extensions add is taken
 * from the first turn of the session once one has run.
 */

import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionCommandContext,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { buildNativeSnapshot, CaptureState, mergeContextOnlyMessages } from "./capture.ts";
import { showInjectionsView } from "./ui/injections-view.ts";
import { showUsageView } from "./ui/usage-view.ts";
import { computeUsage, toReportedUsage } from "./usage.ts";

const DEGRADED_REASON = "No turn has run yet, so additions by other extensions were not observed.";
const ARGUMENTS = [
	{ value: "usage", label: "usage", description: "Show estimated context usage" },
	{ value: "injections", label: "injections", description: "Explore context injections" },
] satisfies AutocompleteItem[];

export function registerContext(pi: ExtensionAPI): void {
	const capture = new CaptureState();

	pi.on("before_agent_start", (event) => {
		capture.prepare(event.systemPromptOptions);
	});

	pi.on("context", (event, ctx) => {
		capture.finalize({
			systemPrompt: ctx.getSystemPrompt(),
			messages: event.messages,
			baselineMessages: sessionMessages(ctx),
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
		});
	});

	pi.registerCommand("context", {
		// RegisteredCommand has no argumentHint; mimic pi's `<hint> — <description>` style.
		description: "[usage|injections] — Inspect context usage or injections",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trimStart().toLowerCase();
			const matches = ARGUMENTS.filter((option) => option.value.startsWith(normalized));
			return matches.length > 0 ? matches.map((option) => ({ ...option })) : null;
		},
		handler: async (args, ctx) => {
			const view = args.trim().toLowerCase();
			if (view !== "" && view !== "usage" && view !== "injections") {
				report(ctx, "Usage: /context [usage|injections]", "error");
				return;
			}
			if (ctx.mode !== "tui") {
				report(ctx, "/context requires TUI mode.", "warning");
				return;
			}

			const captured = capture.snapshot;
			const degradedReason = captured === undefined ? DEGRADED_REASON : undefined;
			const native = buildNativeSnapshot({
				systemPrompt: ctx.getSystemPrompt(),
				options: ctx.getSystemPromptOptions(),
				allTools: pi.getAllTools(),
				activeToolNames: pi.getActiveTools(),
			});

			if (view === "injections") {
				await showInjectionsView(ctx, { snapshot: captured ?? native, degradedReason });
				return;
			}
			await showUsageView(ctx, {
				usage: computeUsage({
					// The prompt and tools are read live; only injected messages come from the capture.
					snapshot: mergeContextOnlyMessages(native, captured),
					messages: sessionMessages(ctx),
					reported: toReportedUsage(ctx.getContextUsage()),
					modelLabel: ctx.model?.id,
					autoCompactReserveTokens: autoCompactReserveTokens(ctx),
				}),
				degradedReason,
			});
		},
	});
}

/** The current session branch as messages; ReadonlySessionManager has no builder of its own. */
function sessionMessages(context: {
	sessionManager: {
		getEntries: () => Parameters<typeof buildSessionContext>[0];
		getLeafId: () => string | null;
	};
}): ReturnType<typeof buildSessionContext>["messages"] {
	return buildSessionContext(context.sessionManager.getEntries(), context.sessionManager.getLeafId())
		.messages;
}

/**
 * The auto-compaction reserve from the same merged settings files pi uses, or
 * undefined when auto-compaction is disabled. Read when the view opens because
 * `reserveTokens` has no runtime setter but `enabled` can change.
 */
function autoCompactReserveTokens(context: ExtensionCommandContext): number | undefined {
	try {
		const settings = SettingsManager.create(context.cwd, undefined, {
			projectTrusted: context.isProjectTrusted(),
		});
		if (!settings.getCompactionEnabled()) return undefined;
		return settings.getCompactionReserveTokens();
	} catch {
		// Unreadable settings degrade to a map without the buffer, not a failed view.
		return undefined;
	}
}

/** Report command errors in both interactive and headless modes. */
function report(context: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	if (context.hasUI) {
		context.ui.notify(message, type);
		return;
	}
	process.stderr.write(`${message}\n`);
}
