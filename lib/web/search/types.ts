/**
 * Provider interface for web search.
 *
 * A backend implements `isAvailable` and `search` and is added to the registry
 * in ./index.ts. Nothing else in the tool layer needs to change.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SearchProviderId, WebSearchConfig } from "../config.ts";

export type Recency = "day" | "week" | "month" | "year";

export interface SearchRequest {
	query: string;
	limit: number;
	recency?: Recency;
	/** Hostnames to keep; empty means no restriction. */
	include: string[];
	/** Hostnames to drop. */
	exclude: string[];
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	publishedAt?: string;
	/** Provider(s) that returned this URL, joined with "+" after deduplication. */
	provider: string;
}

export interface ProviderEnv {
	config: WebSearchConfig;
	ctx: ExtensionContext;
	signal?: AbortSignal;
}

export interface SearchProvider {
	id: SearchProviderId;
	label: string;
	/** Cheap, side-effect free check for a usable credential or endpoint. */
	isAvailable(env: ProviderEnv): Promise<boolean>;
	search(request: SearchRequest, env: ProviderEnv): Promise<SearchResult[]>;
}

const RECENCY_DAYS: Record<Recency, number> = { day: 1, week: 7, month: 30, year: 365 };

export function recencyStartDate(recency: Recency, now = Date.now()): string {
	return new Date(now - RECENCY_DAYS[recency] * 86_400_000).toISOString();
}

export function hostnameOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return undefined;
	}
}

/** Apply include/exclude host filters for backends that cannot express them natively. */
export function matchesDomains(url: string, request: SearchRequest): boolean {
	if (request.include.length === 0 && request.exclude.length === 0) return true;
	const host = hostnameOf(url);
	if (!host) return false;
	const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
	if (request.exclude.some(matches)) return false;
	return request.include.length === 0 || request.include.some(matches);
}

/** Normalize a date-ish provider field to an ISO string, or drop it. */
export function toIsoDate(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export function cleanText(value: unknown, maxLength = 400): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
