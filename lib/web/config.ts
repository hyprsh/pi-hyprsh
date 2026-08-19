/**
 * Configuration for the web feature.
 *
 * Read from the `web` section of ~/.pi/agent/pi-hyprsh.json. Unlike the rest of
 * this package, malformed values are not silently replaced by defaults: a bad
 * value here would otherwise send a request nobody asked for. Validation throws
 * with the offending key, and the tools surface that as a tool error rather
 * than breaking pi startup.
 *
 * Credentials may be given literally or as an environment reference ($VAR or
 * ${VAR}). Shell commands are deliberately not supported.
 */

import { readFileSync } from "node:fs";
import { configPath } from "../config.ts";

/**
 * Providers this pack talks to.
 *
 * The set is deliberately limited to what costs nothing beyond a subscription
 * you already hold: `openai` and `xai` ride the Codex and SuperGrok sign-ins,
 * `exa` uses its keyless endpoint, and `searxng` is whatever instance you run.
 * Metered search APIs are out of scope, so there is no key to leak and no bill
 * a runaway fan-out can build up.
 */
export type SearchProviderId = "openai" | "xai" | "exa" | "searxng";

export const SEARCH_PROVIDER_IDS: SearchProviderId[] = ["openai", "xai", "exa", "searxng"];

export interface WebSearchConfig {
	/** Order tried by provider "auto"; the first available provider that answers wins. */
	priority: SearchProviderId[];
	timeoutMs: number;
	/**
	 * How long provider "all" waits for the concurrent fan-out before returning
	 * what has arrived. Providers still running are reported, not waited for.
	 * Distinct from timeoutMs, which is the hard cap on a single request.
	 */
	deadlineMs: number;
	cacheTtlMs: number;
	retries: number;
	openaiApiKey?: string;
	openaiModel?: string;
	xaiApiKey?: string;
	xaiModel?: string;
	searxngBaseUrl?: string;
}

export interface WebFetchConfig {
	timeoutMs: number;
	maxBytes: number;
	maxRedirects: number;
	maxChars: number;
	cacheTtlMs: number;
	retries: number;
	userAgent: string;
	/** Remote extractor used only when direct extraction fails, e.g. https://r.jina.ai/. */
	extractorUrl?: string;
	extractorApiKey?: string;
}

export interface WebConfig {
	search: WebSearchConfig;
	fetch: WebFetchConfig;
}

const DEFAULT_SEARCH: WebSearchConfig = {
	priority: ["openai", "xai", "exa", "searxng"],
	timeoutMs: 60_000,
	deadlineMs: 15_000,
	cacheTtlMs: 300_000,
	retries: 2,
};

const DEFAULT_FETCH: WebFetchConfig = {
	timeoutMs: 30_000,
	maxBytes: 8 * 1024 * 1024,
	maxRedirects: 5,
	maxChars: 50_000,
	cacheTtlMs: 300_000,
	retries: 2,
	userAgent: "Mozilla/5.0 (compatible; pi-hyprsh/0.1; +https://github.com/badlogic/pi-mono)",
};

function record(value: unknown, key: string, path: string): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value))
		throw new Error(`${key} in ${path} must be an object`);
	return value as Record<string, unknown>;
}

function positive(value: unknown, key: string, path: string, fallback: number): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${key} in ${path} must be a positive number`);
	}
	return value;
}

function count(value: unknown, key: string, path: string, fallback: number): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10) {
		throw new Error(`${key} in ${path} must be an integer between 0 and 10`);
	}
	return value;
}

/** A literal value, or $VAR / ${VAR} resolved from the environment. */
function secret(value: unknown, key: string, path: string, envVar: string): string | undefined {
	if (value === undefined || value === null) return process.env[envVar]?.trim() || undefined;
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${key} in ${path} must be a non-empty string`);
	const trimmed = value.trim();
	const reference = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(trimmed);
	if (!reference?.[1]) return trimmed;
	return process.env[reference[1]]?.trim() || undefined;
}

function text(value: unknown, key: string, path: string, fallback?: string): string | undefined {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${key} in ${path} must be a non-empty string`);
	return value.trim();
}

function httpUrl(value: unknown, key: string, path: string, envVar?: string): string | undefined {
	const raw = value === undefined || value === null ? (envVar ? process.env[envVar] : undefined) : value;
	if (raw === undefined || raw === null || raw === "") return undefined;
	if (typeof raw !== "string") throw new Error(`${key} in ${path} must be an http(s) URL`);
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error(`${key} in ${path} must be an http(s) URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${key} in ${path} must use http or https`);
	}
	if (url.username || url.password) throw new Error(`${key} in ${path} must not embed credentials`);
	return url.toString().replace(/\/+$/, "");
}

function priority(value: unknown, path: string): SearchProviderId[] {
	if (value === undefined || value === null) return DEFAULT_SEARCH.priority;
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`web.search.priority in ${path} must be a non-empty array of provider ids`);
	}
	const seen: SearchProviderId[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !SEARCH_PROVIDER_IDS.includes(entry as SearchProviderId)) {
			throw new Error(
				`web.search.priority in ${path} contains an unknown provider: ${JSON.stringify(entry)}. Known: ${SEARCH_PROVIDER_IDS.join(", ")}`,
			);
		}
		if (!seen.includes(entry as SearchProviderId)) seen.push(entry as SearchProviderId);
	}
	return seen;
}

function parse(raw: Record<string, unknown>, path: string): WebConfig {
	const web = record(raw.web, "web", path);
	const search = record(web.search, "web.search", path);
	const fetch = record(web.fetch, "web.fetch", path);

	return {
		search: {
			priority: priority(search.priority, path),
			timeoutMs: positive(search.timeoutMs, "web.search.timeoutMs", path, DEFAULT_SEARCH.timeoutMs),
			deadlineMs: positive(search.deadlineMs, "web.search.deadlineMs", path, DEFAULT_SEARCH.deadlineMs),
			cacheTtlMs: positive(search.cacheTtlMs, "web.search.cacheTtlMs", path, DEFAULT_SEARCH.cacheTtlMs),
			retries: count(search.retries, "web.search.retries", path, DEFAULT_SEARCH.retries),
			openaiApiKey: secret(search.openaiApiKey, "web.search.openaiApiKey", path, "OPENAI_API_KEY"),
			openaiModel: text(search.openaiModel, "web.search.openaiModel", path),
			xaiApiKey: secret(search.xaiApiKey, "web.search.xaiApiKey", path, "XAI_API_KEY"),
			xaiModel: text(search.xaiModel, "web.search.xaiModel", path),
			searxngBaseUrl: httpUrl(search.searxngBaseUrl, "web.search.searxngBaseUrl", path, "SEARXNG_BASE_URL"),
		},
		fetch: {
			timeoutMs: positive(fetch.timeoutMs, "web.fetch.timeoutMs", path, DEFAULT_FETCH.timeoutMs),
			maxBytes: positive(fetch.maxBytes, "web.fetch.maxBytes", path, DEFAULT_FETCH.maxBytes),
			maxRedirects: count(fetch.maxRedirects, "web.fetch.maxRedirects", path, DEFAULT_FETCH.maxRedirects),
			maxChars: positive(fetch.maxChars, "web.fetch.maxChars", path, DEFAULT_FETCH.maxChars),
			cacheTtlMs: positive(fetch.cacheTtlMs, "web.fetch.cacheTtlMs", path, DEFAULT_FETCH.cacheTtlMs),
			retries: count(fetch.retries, "web.fetch.retries", path, DEFAULT_FETCH.retries),
			userAgent: text(fetch.userAgent, "web.fetch.userAgent", path, DEFAULT_FETCH.userAgent) as string,
			extractorUrl: httpUrl(fetch.extractorUrl, "web.fetch.extractorUrl", path),
			extractorApiKey: secret(fetch.extractorApiKey, "web.fetch.extractorApiKey", path, "JINA_API_KEY"),
		},
	};
}

let cached: { config?: WebConfig; error?: Error } | undefined;

/**
 * Load and validate the web config once per session. A validation error is
 * memoized and rethrown, so an invalid file gives the same clear message on
 * every call instead of being silently defaulted away.
 */
export function loadWebConfig(path = configPath()): WebConfig {
	if (!cached) {
		let raw: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				raw = parsed as Record<string, unknown>;
			}
		} catch (error) {
			// A missing file is the default install. A malformed file is the user's
			// whole pi-hyprsh config and is already reported by loadConfig().
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				cached = { error: new Error(`Failed to read ${path}: ${(error as Error).message}`) };
			}
		}
		if (!cached) {
			try {
				cached = { config: parse(raw, path) };
			} catch (error) {
				cached = { error: error instanceof Error ? error : new Error(String(error)) };
			}
		}
	}
	if (cached.error) throw cached.error;
	return cached.config as WebConfig;
}
