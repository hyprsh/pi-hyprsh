/**
 * Brave Search API.
 *
 * Brave has no domain filter parameter. A single include is expressed as a
 * `site:` operator, everything else is filtered client-side over a wider result
 * page, so the requested limit is still met where Brave has the coverage.
 */

import { apiFetch } from "../http.ts";
import { cleanText, matchesDomains, type SearchProvider, type SearchResult, toIsoDate } from "./types.ts";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const FRESHNESS: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };
const MAX_COUNT = 20;

interface BraveResponse {
	web?: {
		results?: { title?: unknown; url?: unknown; description?: unknown; page_age?: unknown }[];
	};
}

export const braveProvider: SearchProvider = {
	id: "brave",
	label: "Brave",

	async isAvailable(env) {
		return Boolean(env.config.braveApiKey);
	},

	async search(request, env) {
		const apiKey = env.config.braveApiKey;
		if (!apiKey) {
			throw new Error("Brave search is unavailable. Set BRAVE_API_KEY or configure web.search.braveApiKey.");
		}

		const filtered = request.include.length > 0 || request.exclude.length > 0;
		const query =
			request.include.length === 1 ? `${request.query} site:${request.include[0]}` : request.query;
		const params = new URLSearchParams({
			q: query,
			count: String(filtered ? MAX_COUNT : Math.min(request.limit, MAX_COUNT)),
		});
		const freshness = request.recency ? FRESHNESS[request.recency] : undefined;
		if (freshness) params.set("freshness", freshness);

		const body = await apiFetch(`${BRAVE_SEARCH_URL}?${params.toString()}`, {
			headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
			timeoutMs: env.config.timeoutMs,
			signal: env.signal,
			label: "Brave search",
		});

		let parsed: BraveResponse;
		try {
			parsed = JSON.parse(body) as BraveResponse;
		} catch {
			throw new Error("Brave search returned invalid JSON");
		}

		const results: SearchResult[] = [];
		for (const item of parsed.web?.results ?? []) {
			if (typeof item.url !== "string" || !matchesDomains(item.url, request)) continue;
			results.push({
				title: cleanText(item.title, 200) || item.url,
				url: item.url,
				snippet: cleanText(item.description),
				publishedAt: toIsoDate(item.page_age),
				provider: "brave",
			});
		}
		return results.slice(0, request.limit);
	},
};
