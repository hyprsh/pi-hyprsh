/**
 * web_search and web_fetch.
 *
 * Both tools return exactly what the network returned: normalized results with
 * visible provenance, and page text extracted locally. Nothing is summarized by
 * a model on the way through, and nothing is persisted.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compact } from "../compact/index.ts";
import { withReason } from "../reason/index.ts";
import { loadWebConfig, SEARCH_PROVIDER_IDS } from "./config.ts";
import { fetchUrl } from "./fetch/index.ts";
import { type ProviderSelection, runSearch } from "./search/index.ts";
import type { Recency, SearchRequest, SearchResult } from "./search/types.ts";

const SELECTIONS = ["auto", ...SEARCH_PROVIDER_IDS, "all"] as const;
const RECENCIES = ["day", "week", "month", "year"] as const;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

function StringEnum<T extends readonly string[]>(values: T, description: string) {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

/** Accepts bare hostnames or URLs; a leading "-" excludes. */
function parseDomains(domains: string[] | undefined): { include: string[]; exclude: string[] } {
	const include: string[] = [];
	const exclude: string[] = [];
	for (const raw of domains ?? []) {
		if (typeof raw !== "string" || !raw.trim()) throw new Error("domains entries must be non-empty strings");
		const negated = raw.trim().startsWith("-");
		let value = negated ? raw.trim().slice(1).trim() : raw.trim();
		try {
			if (value.includes("://")) value = new URL(value).hostname;
		} catch {
			throw new Error(`domains contains an invalid entry: ${raw}`);
		}
		const host =
			value
				.toLowerCase()
				.replace(/^www\./, "")
				.replace(/^\.+|\.+$/g, "")
				.split("/")[0] ?? "";
		if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) {
			throw new Error(`domains contains an invalid hostname: ${raw}`);
		}
		const target = negated ? exclude : include;
		if (!target.includes(host)) target.push(host);
	}
	return { include, exclude };
}

function buildRequest(params: {
	query: string;
	limit?: number;
	recency?: string;
	domains?: string[];
}): SearchRequest {
	const query = params.query?.trim();
	if (!query) throw new Error("query must be a non-empty string");
	if (
		params.limit !== undefined &&
		(!Number.isInteger(params.limit) || params.limit < 1 || params.limit > MAX_LIMIT)
	) {
		throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
	}
	const { include, exclude } = parseDomains(params.domains);
	return {
		query,
		limit: params.limit ?? DEFAULT_LIMIT,
		recency: params.recency as Recency | undefined,
		include,
		exclude,
	};
}

function formatResults(results: SearchResult[]): string {
	return results
		.map((result, index) => {
			const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`];
			if (result.snippet) lines.push(`   ${result.snippet}`);
			const date = result.publishedAt?.slice(0, 10);
			lines.push(`   ${date ? `${date} · ` : ""}${result.provider}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

export function registerWeb(pi: ExtensionAPI): void {
	pi.registerTool(
		compact(
			withReason({
				name: "web_search",
				label: "Web Search",
				description:
					"Search the web and return normalized results (title, url, snippet, publishedAt, provider). Results are raw provider output, never a model-written answer, so read the sources with web_fetch when the snippets are not enough. provider defaults to auto, which tries the configured providers in priority order and falls back on failure; all queries every configured provider at once and merges deduplicated results, reporting any that missed the deadline.",
				promptSnippet: "Search the web and get back normalized, deduplicated results with visible sources.",
				parameters: Type.Object({
					query: Type.String({ description: "What to search for." }),
					provider: Type.Optional(
						StringEnum(
							SELECTIONS,
							"Search backend. auto (default) uses the configured priority order; all queries every configured provider concurrently and returns whichever answered before the deadline.",
						),
					),
					limit: Type.Optional(
						Type.Integer({
							minimum: 1,
							maximum: MAX_LIMIT,
							description: `Maximum results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
						}),
					),
					recency: Type.Optional(StringEnum(RECENCIES, "Only consider pages published within this window.")),
					domains: Type.Optional(
						Type.Array(Type.String(), {
							description:
								'Hostnames to restrict to; prefix with "-" to exclude, e.g. ["docs.python.org", "-reddit.com"].',
						}),
					),
				}),

				async execute(_toolCallId, params, signal, _onUpdate, ctx) {
					const config = loadWebConfig();
					const request = buildRequest(params);
					const selection = (params.provider ?? "auto") as ProviderSelection;

					const run = await runSearch(request, selection, { config: config.search, ctx, signal });
					const attempted = run.outcomes
						.map((outcome) =>
							outcome.ok
								? `${outcome.provider} (${outcome.count})`
								: `${outcome.provider} failed: ${outcome.error}`,
						)
						.join(", ");

					const header = `${run.results.length} result${run.results.length === 1 ? "" : "s"} for "${request.query}" · ${attempted}`;
					const text = run.results.length === 0 ? header : `${header}\n\n${formatResults(run.results)}`;

					return {
						content: [{ type: "text", text }],
						details: { query: request.query, selection, results: run.results, providers: run.outcomes },
					};
				},
			}),
		),
	);

	pi.registerTool(
		compact(
			withReason({
				name: "web_fetch",
				label: "Web Fetch",
				description:
					"Fetch a URL and return its readable content. HTML is reduced to the main article with Mozilla Readability and converted to Markdown; PDF, text, JSON and XML are returned as text. Private, loopback and link-local addresses are refused, redirects are bounded, and the response is size- and time-capped.",
				promptSnippet: "Fetch one URL and read its main content as Markdown or text.",
				parameters: Type.Object({
					url: Type.String({ description: "Absolute http(s) URL to fetch." }),
					maxChars: Type.Optional(
						Type.Integer({
							minimum: 500,
							description: "Truncate the extracted content to this many characters.",
						}),
					),
				}),

				async execute(_toolCallId, params, signal) {
					const config = loadWebConfig();
					const url = params.url?.trim();
					if (!url) throw new Error("url must be a non-empty string");
					if (
						params.maxChars !== undefined &&
						(!Number.isInteger(params.maxChars) || params.maxChars < 500)
					) {
						throw new Error("maxChars must be an integer of at least 500");
					}

					const outcome = await fetchUrl(url, { config: config.fetch, maxChars: params.maxChars, signal });
					const header = [
						outcome.url,
						[
							outcome.title,
							outcome.mime,
							outcome.method,
							`${outcome.chars} chars${outcome.truncated ? " (truncated)" : ""}`,
						]
							.filter(Boolean)
							.join(" · "),
					].join("\n");

					return {
						content: [{ type: "text", text: `${header}\n\n${outcome.content}` }],
						details: {
							url: outcome.url,
							title: outcome.title,
							mime: outcome.mime,
							method: outcome.method,
							chars: outcome.chars,
							truncated: outcome.truncated,
							bytes: outcome.bytes,
						},
					};
				},
			}),
		),
	);
}
