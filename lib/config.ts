/**
 * Configuration for pi-hyprsh.
 *
 * Read from ~/.pi/agent/pi-hyprsh.json. Missing, unreadable and malformed
 * files all fall back to defaults rather than breaking pi startup.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isThinkingLevel, type ThinkingLevel } from "./agents/model.ts";

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

/** `summary` keeps one line per thought; `full` leaves pi's rendering alone. */
export interface ThinkingConfig {
	mode: "summary" | "full";
}

/**
 * Per-agent overrides, keyed by agent name.
 *
 * A model ID the registry does not report as available is ignored rather than
 * fatal, so a config written for one provider does not break every dispatch on
 * another. A thinking level outside pi's own set is dropped here, since the
 * child would refuse it at startup and die for a typo.
 */
export interface AgentsConfig {
	models: Record<string, string>;
	thinking: Record<string, ThinkingLevel>;
}

export interface Config {
	features: {
		footer: boolean;
		reason: boolean;
		compact: boolean;
		context: boolean;
		web: boolean;
		constitution: boolean;
		ask: boolean;
		todo: boolean;
		task: boolean;
	};
	footer: FooterConfig;
	thinking: ThinkingConfig;
	agents: AgentsConfig;
}

const DEFAULTS: Config = {
	features: {
		footer: true,
		reason: true,
		compact: true,
		context: true,
		web: true,
		constitution: true,
		ask: true,
		todo: true,
		task: true,
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
	thinking: {
		mode: "summary",
	},
	agents: {
		models: {},
		thinking: {},
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

/** Keeps only string-to-string pairs; anything else in the object is dropped, not fatal. */
function stringMap(value: unknown): Record<string, string> {
	const raw = record(value);
	if (!raw) return {};
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(raw)) {
		if (typeof entry === "string" && entry.trim()) out[key] = entry.trim();
	}
	return out;
}

function thinkingMap(value: unknown): Record<string, ThinkingLevel> {
	const out: Record<string, ThinkingLevel> = {};
	for (const [key, entry] of Object.entries(stringMap(value))) {
		if (isThinkingLevel(entry)) out[key] = entry;
	}
	return out;
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
	const thinking = record(raw.thinking) ?? {};
	const agents = record(raw.agents) ?? {};
	return {
		features: {
			footer: bool(features.footer, DEFAULTS.features.footer),
			reason: bool(features.reason, DEFAULTS.features.reason),
			compact: bool(features.compact, DEFAULTS.features.compact),
			context: bool(features.context, DEFAULTS.features.context),
			web: bool(features.web, DEFAULTS.features.web),
			constitution: bool(features.constitution, DEFAULTS.features.constitution),
			ask: bool(features.ask, DEFAULTS.features.ask),
			todo: bool(features.todo, DEFAULTS.features.todo),
			task: bool(features.task, DEFAULTS.features.task),
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
		thinking: {
			mode: thinking.mode === "full" ? "full" : DEFAULTS.thinking.mode,
		},
		agents: {
			models: stringMap(agents.models),
			thinking: thinkingMap(agents.thinking),
		},
	};
}
