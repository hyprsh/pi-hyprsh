/**
 * Footer segment renderers.
 *
 * Each returns a rendered string, or "" when it has nothing to show. No
 * segment draws a bar or gauge; percentages are printed as numbers and carry
 * the whole signal through colour.
 */

import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Thresholds } from "../config.ts";
import type { QuotaSnapshot } from "../quota/index.ts";

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/**
 * Percentages share one escalation so the whole line reads consistently:
 * quiet below the warning threshold, amber above it, bold red above critical.
 * The label escalates with the number so a critical segment is visible even
 * in peripheral vision.
 */
function renderPercent(label: string, percent: number, thresholds: Thresholds, theme: Theme): string {
	const text = `${label}${Math.round(percent)}%`;
	if (percent >= thresholds.critical) return theme.bold(theme.fg("error", text));
	if (percent >= thresholds.warning) return theme.fg("warning", text);
	return theme.fg("dim", label) + theme.fg("muted", `${Math.round(percent)}%`);
}

export function cwdSegment(cwd: string, theme: Theme): string {
	const home = homedir();
	const shown = cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
	return theme.fg("accent", shown);
}

/** Model and thinking level share pi's own `id:thinking` shorthand. */
export function modelSegment(model: string | undefined, thinking: string | undefined, theme: Theme): string {
	const id = model ?? "no-model";
	if (!thinking || thinking === "off") return theme.fg("muted", id);
	return theme.fg("muted", id) + theme.fg("dim", `:${thinking}`);
}

export function tpsSegment(tps: number | null, theme: Theme): string {
	if (tps === null || !Number.isFinite(tps) || tps <= 0) return "";
	return theme.fg("muted", `${Math.round(tps)}`) + theme.fg("dim", " t/s");
}

export function contextSegment(usage: ContextUsage | null, thresholds: Thresholds, theme: Theme): string {
	if (!usage || usage.percent === null) return theme.fg("dim", "ctx: —");
	return renderPercent("ctx: ", usage.percent, thresholds, theme);
}

function resetCountdown(resetAt: number | undefined): string {
	if (resetAt === undefined || !Number.isFinite(resetAt)) return "";
	const remaining = resetAt - Date.now();
	if (remaining <= 0) return "now";

	const minutes = Math.ceil(remaining / 60_000);
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours < 24) return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;

	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
}

function quotaReset(resetAt: number | undefined, theme: Theme): string {
	const countdown = resetCountdown(resetAt);
	return countdown ? theme.fg("dim", ` (↻ ${countdown})`) : "";
}

export function quotaSegment(snapshot: QuotaSnapshot | null, thresholds: Thresholds, theme: Theme): string {
	if (!snapshot) return "";
	if (snapshot.error) return theme.fg("dim", `quota ${snapshot.error}`);
	if (snapshot.windows.length === 0) return "";

	return snapshot.windows
		.map(
			(window) =>
				renderPercent(`${window.label}: `, window.percent, thresholds, theme) +
				quotaReset(window.resetAt, theme),
		)
		.join(theme.fg("dim", " / "));
}
