/**
 * Search orchestration: provider registry, selection, deduplication.
 *
 * `auto` walks the configured priority order and stops at the first provider
 * that answers. `all` queries every available provider concurrently, bounded by
 * a deadline. In both cases one provider failing never fails the request while
 * another succeeds — failures are reported alongside the results instead of
 * replacing them.
 */

import { TtlCache } from "../cache.ts";
import type { SearchProviderId } from "../config.ts";
import { withRetry } from "../http.ts";
import { braveProvider } from "./brave.ts";
import { exaProvider } from "./exa.ts";
import { openaiProvider } from "./openai.ts";
import { searxngProvider } from "./searxng.ts";
import type { ProviderEnv, SearchProvider, SearchRequest, SearchResult } from "./types.ts";
import { xaiProvider } from "./xai.ts";

export type ProviderSelection = SearchProviderId | "auto" | "all";

const PROVIDERS: Record<SearchProviderId, SearchProvider> = {
	openai: openaiProvider,
	xai: xaiProvider,
	brave: braveProvider,
	searxng: searxngProvider,
	exa: exaProvider,
};

const TRACKING_PARAMS = /^(utm_|ref$|ref_src$|fbclid$|gclid$|mc_eid$|igshid$|spm$|source$)/i;

export interface ProviderOutcome {
	provider: SearchProviderId;
	ok: boolean;
	count: number;
	error?: string;
}

export interface SearchRun {
	results: SearchResult[];
	outcomes: ProviderOutcome[];
}

let cache: TtlCache<SearchResult[]> | undefined;

function cached(ttlMs: number): TtlCache<SearchResult[]> {
	if (!cache) cache = new TtlCache<SearchResult[]>(ttlMs);
	return cache;
}

function cacheKey(provider: SearchProviderId, request: SearchRequest): string {
	return JSON.stringify([
		provider,
		request.query,
		request.limit,
		request.recency ?? null,
		request.include,
		request.exclude,
	]);
}

/** Stable identity for deduplication; the original URL is what gets reported. */
export function canonicalUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
		for (const key of [...parsed.searchParams.keys()]) {
			if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
		}
		parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
		return parsed.toString();
	} catch {
		return url;
	}
}

/** Merge provider result sets, keeping the richest copy of each canonical URL. */
export function dedupe(groups: SearchResult[][], limit: number): SearchResult[] {
	const byUrl = new Map<string, SearchResult>();
	for (const group of groups) {
		for (const result of group) {
			const key = canonicalUrl(result.url);
			const existing = byUrl.get(key);
			if (!existing) {
				byUrl.set(key, { ...result });
				continue;
			}
			const providers = existing.provider.split("+");
			if (!providers.includes(result.provider)) existing.provider = [...providers, result.provider].join("+");
			if (result.snippet.length > existing.snippet.length) existing.snippet = result.snippet;
			existing.publishedAt ??= result.publishedAt;
		}
	}
	return [...byUrl.values()].slice(0, limit);
}

async function runProvider(
	provider: SearchProvider,
	request: SearchRequest,
	env: ProviderEnv,
): Promise<SearchResult[]> {
	const key = cacheKey(provider.id, request);
	const store = cached(env.config.cacheTtlMs);
	const hit = store.get(key);
	if (hit) return hit;

	const results = await withRetry(() => provider.search(request, env), {
		retries: env.config.retries,
		signal: env.signal,
	});
	store.set(key, results);
	return results;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Whole seconds read better, but a sub-second deadline must not print as "0s". */
function duration(ms: number): string {
	return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/** A timer that can be cleared, so a finished fan-out leaves nothing pending. */
function deadline(ms: number): { elapsed: Promise<void>; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const elapsed = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});
	return {
		elapsed,
		cancel: () => {
			if (timer) clearTimeout(timer);
		},
	};
}

async function availableProviders(env: ProviderEnv): Promise<SearchProvider[]> {
	const ordered = env.config.priority.map((id) => PROVIDERS[id]);
	const flags = await Promise.all(ordered.map((provider) => provider.isAvailable(env).catch(() => false)));
	return ordered.filter((_, index) => flags[index]);
}

export async function runSearch(
	request: SearchRequest,
	selection: ProviderSelection,
	env: ProviderEnv,
): Promise<SearchRun> {
	if (selection !== "auto" && selection !== "all") {
		const provider = PROVIDERS[selection];
		const results = await runProvider(provider, request, env);
		return {
			results: dedupe([results], request.limit),
			outcomes: [{ provider: provider.id, ok: true, count: results.length }],
		};
	}

	const providers = await availableProviders(env);
	if (providers.length === 0) {
		throw new Error(
			"No search provider answered. Exa's keyless endpoint needs no setup, so this means it is unreachable; sign in with /login for an OpenAI or xAI subscription, or set BRAVE_API_KEY or SEARXNG_BASE_URL.",
		);
	}

	const outcomes: ProviderOutcome[] = [];

	if (selection === "auto") {
		for (const provider of providers) {
			try {
				const results = await runProvider(provider, request, env);
				outcomes.push({ provider: provider.id, ok: true, count: results.length });
				if (results.length > 0) return { results: dedupe([results], request.limit), outcomes };
			} catch (error) {
				if (env.signal?.aborted) throw error;
				outcomes.push({ provider: provider.id, ok: false, count: 0, error: message(error) });
			}
		}
		if (outcomes.every((outcome) => !outcome.ok)) {
			throw new Error(
				`All search providers failed:\n${outcomes.map((o) => `- ${o.provider}: ${o.error}`).join("\n")}`,
			);
		}
		return { results: [], outcomes };
	}

	/**
	 * Wait for every provider, but not past the deadline. A provider that runs
	 * its search inside a model inference answers in seconds to tens of seconds,
	 * so without this the slowest one alone sets the latency of the merged
	 * result. Stragglers are deliberately left running: nothing waits on them,
	 * and their result still lands in the cache for the next identical query.
	 */
	const answered = new Map<number, { results?: SearchResult[]; error?: unknown }>();
	const recorded = providers.map((provider, index) =>
		runProvider(provider, request, env).then(
			(results) => {
				answered.set(index, { results });
			},
			(error) => {
				answered.set(index, { error });
			},
		),
	);

	const limit = deadline(env.config.deadlineMs);
	try {
		await Promise.race([Promise.all(recorded), limit.elapsed]);
	} finally {
		limit.cancel();
	}

	const groups: SearchResult[][] = [];
	providers.forEach((provider, index) => {
		const entry = answered.get(index);
		if (!entry) {
			outcomes.push({
				provider: provider.id,
				ok: false,
				count: 0,
				error: `did not answer within ${duration(env.config.deadlineMs)}`,
			});
		} else if (entry.results) {
			groups.push(entry.results);
			outcomes.push({ provider: provider.id, ok: true, count: entry.results.length });
		} else {
			outcomes.push({ provider: provider.id, ok: false, count: 0, error: message(entry.error) });
		}
	});
	if (groups.length === 0) {
		throw new Error(
			`All search providers failed:\n${outcomes.map((o) => `- ${o.provider}: ${o.error}`).join("\n")}`,
		);
	}
	return { results: dedupe(groups, request.limit), outcomes };
}
