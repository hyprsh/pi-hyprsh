/**
 * Single-line footer.
 *
 * Pi's setFooter contract returns an array of lines; this feature always
 * returns exactly one, so the footer never grows past a single row.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { FooterConfig } from "../config.ts";
import { fetchQuota, type QuotaSnapshot } from "../quota/index.ts";
import { contextSegment, cwdSegment, modelSegment, quotaSegment, tpsSegment } from "./segments.ts";

const QUOTA_REFRESH_MS = 5 * 60 * 1000;
const RESET_RENDER_MS = 1_000;
const SEPARATOR = " · ";
/** Below this, a live rate is noise rather than a measurement. */
const MIN_LIVE_MS = 500;

export function registerFooter(pi: ExtensionAPI, config: FooterConfig): void {
	let quota: QuotaSnapshot | null = null;
	let requestRender: () => void = () => {};

	/** Turn timing for tokens per second. */
	let turnStart: number | null = null;
	let turnOutputTokens = 0;
	let lastTps: number | null = null;

	function currentTps(): number | null {
		if (turnStart !== null) {
			const elapsed = Date.now() - turnStart;
			if (elapsed >= MIN_LIVE_MS && turnOutputTokens > 0) return (turnOutputTokens * 1000) / elapsed;
		}
		return lastTps;
	}

	async function refreshQuota(ctx: ExtensionContext): Promise<void> {
		if (!config.segments.quota) return;
		quota = await fetchQuota(ctx.model?.provider);
		requestRender();
	}

	function setupFooter(ctx: ExtensionContext): void {
		ctx.ui.setFooter((tui, theme) => {
			requestRender = () => tui.requestRender();
			const timer = setInterval(() => void refreshQuota(ctx), QUOTA_REFRESH_MS);
			const resetTimer = config.segments.quota
				? setInterval(() => requestRender(), RESET_RENDER_MS)
				: undefined;

			return {
				dispose() {
					clearInterval(timer);
					if (resetTimer) clearInterval(resetTimer);
					requestRender = () => {};
				},
				invalidate() {},
				render(width: number): string[] {
					const parts: string[] = [];
					if (config.segments.cwd) parts.push(cwdSegment(ctx.cwd, theme));
					if (config.segments.model) {
						parts.push(modelSegment(ctx.model?.id, ctx.thinkingLevel, theme));
					}
					if (config.segments.tps) parts.push(tpsSegment(currentTps(), theme));
					if (config.segments.context) {
						parts.push(contextSegment(ctx.getContextUsage() ?? null, config.thresholds, theme));
					}
					if (config.segments.quota) parts.push(quotaSegment(quota, config.thresholds, theme));

					const line = parts.filter(Boolean).join(theme.fg("dim", SEPARATOR));
					return line ? [truncateToWidth(line, width)] : [];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setupFooter(ctx);
		void refreshQuota(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		void refreshQuota(ctx);
	});

	pi.on("turn_start", async () => {
		turnStart = Date.now();
		turnOutputTokens = 0;
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		// The streaming message accumulates usage, so take the highest seen.
		const output = (event.message as AssistantMessage).usage?.output;
		if (typeof output === "number" && Number.isFinite(output)) {
			turnOutputTokens = Math.max(turnOutputTokens, output);
		}
	});

	pi.on("turn_end", async (event) => {
		const elapsed = turnStart === null ? 0 : Date.now() - turnStart;
		const message = event.message.role === "assistant" ? (event.message as AssistantMessage) : null;
		const output = message?.usage?.output ?? turnOutputTokens;

		if (elapsed >= MIN_LIVE_MS && output > 0) lastTps = (output * 1000) / elapsed;
		turnStart = null;
		turnOutputTokens = 0;
		requestRender();
	});
}
