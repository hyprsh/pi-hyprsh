/**
 * Configuration for pi-hyprsh.
 *
 * Read from ~/.pi/agent/pi-hyprsh.json. Missing, unreadable and malformed
 * files all fall back to defaults rather than breaking pi startup.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FooterSegments {
	cwd: boolean;
	model: boolean;
	tps: boolean;
	context: boolean;
	quota: boolean;
}

/** Percentages at or above these values change colour. */
export interface Thresholds {
	warning: number;
	critical: number;
}

export interface FooterConfig {
	segments: FooterSegments;
	thresholds: Thresholds;
}

export interface Config {
	features: {
		footer: boolean;
		reason: boolean;
		context: boolean;
		web: boolean;
		constitution: boolean;
	};
	footer: FooterConfig;
}

const DEFAULTS: Config = {
	features: {
		footer: true,
		reason: true,
		context: true,
		web: true,
		constitution: true,
	},
	footer: {
		segments: {
			cwd: true,
			model: true,
			tps: true,
			context: true,
			quota: true,
		},
		thresholds: {
			warning: 70,
			critical: 90,
		},
	},
};

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export function configPath(): string {
	return join(agentDir(), "pi-hyprsh.json");
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function record(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function percent(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(100, value));
}

/** A critical threshold below the warning threshold would never colour correctly. */
function orderThresholds(thresholds: Thresholds): Thresholds {
	if (thresholds.critical < thresholds.warning) {
		return { warning: thresholds.critical, critical: thresholds.warning };
	}
	return thresholds;
}

export function loadConfig(path = configPath()): Config {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return DEFAULTS;
	}

	const raw = record(parsed);
	if (!raw) return DEFAULTS;

	const features = record(raw.features) ?? {};
	const footer = record(raw.footer);
	const segments = record(footer?.segments) ?? {};
	const thresholds = record(footer?.thresholds) ?? {};
	return {
		features: {
			footer: bool(features.footer, DEFAULTS.features.footer),
			reason: bool(features.reason, DEFAULTS.features.reason),
			context: bool(features.context, DEFAULTS.features.context),
			web: bool(features.web, DEFAULTS.features.web),
			constitution: bool(features.constitution, DEFAULTS.features.constitution),
		},
		footer: {
			segments: {
				cwd: bool(segments.cwd, DEFAULTS.footer.segments.cwd),
				model: bool(segments.model, DEFAULTS.footer.segments.model),
				tps: bool(segments.tps, DEFAULTS.footer.segments.tps),
				context: bool(segments.context, DEFAULTS.footer.segments.context),
				quota: bool(segments.quota, DEFAULTS.footer.segments.quota),
			},
			thresholds: orderThresholds({
				warning: percent(thresholds.warning, DEFAULTS.footer.thresholds.warning),
				critical: percent(thresholds.critical, DEFAULTS.footer.thresholds.critical),
			}),
		},
	};
}
