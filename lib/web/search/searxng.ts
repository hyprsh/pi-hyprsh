/**
 * Self-hosted SearXNG. Optional: available only once a base URL is configured.
 *
 * The instance is usually on a LAN or on localhost, so this request is
 * deliberately exempt from the private-address checks that guard web_fetch. The
 * user named the host explicitly in their own config; no untrusted input can
 * point this anywhere else, and no credential is attached.
 */

import { apiFetch } from "../http.ts";
import { cleanText, matchesDomains, type SearchProvider, type SearchResult, toIsoDate } from "./types.ts";

interface SearxngResponse {
	results?: { title?: unknown; url?: unknown; content?: unknown; publishedDate?: unknown }[];
}

export const searxngProvider: SearchProvider = {
	id: "searxng",
	label: "SearXNG",

	async isAvailable(env) {
		return Boolean(env.config.searxngBaseUrl);
	},

	async search(request, env) {
		const baseUrl = env.config.searxngBaseUrl;
		if (!baseUrl) {
			throw new Error(
				"SearXNG search is unavailable. Set SEARXNG_BASE_URL or configure web.search.searxngBaseUrl.",
			);
		}

		const url = new URL(`${baseUrl}/search`);
		url.searchParams.set("q", request.query);
		url.searchParams.set("format", "json");
		if (request.recency) url.searchParams.set("time_range", request.recency);

		const body = await apiFetch(url.toString(), {
			headers: { Accept: "application/json" },
			timeoutMs: env.config.timeoutMs,
			signal: env.signal,
			label: "SearXNG search",
		});

		let parsed: SearxngResponse;
		try {
			parsed = JSON.parse(body) as SearxngResponse;
		} catch {
			throw new Error("SearXNG returned invalid JSON. Enable the JSON format in its settings.yml.");
		}

		const results: SearchResult[] = [];
		for (const item of parsed.results ?? []) {
			if (typeof item.url !== "string" || !matchesDomains(item.url, request)) continue;
			results.push({
				title: cleanText(item.title, 200) || item.url,
				url: item.url,
				snippet: cleanText(item.content),
				publishedAt: toIsoDate(item.publishedDate),
				provider: "searxng",
			});
		}
		return results.slice(0, request.limit);
	},
};
