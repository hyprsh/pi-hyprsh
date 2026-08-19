/**
 * Exa search, keyless.
 *
 * Exa's hosted, unauthenticated MCP endpoint exposes search behind a JSON-RPC
 * tool call. It is rate limited and answers 429 when busy, which is the price
 * of needing nothing configured at all — and that is what makes it the
 * deterministic fallback when a subscription-backed provider fails. The metered
 * /search endpoint is deliberately not used: this pack sends no request that
 * bills a per-query API.
 */

import { apiFetch, HttpError } from "../http.ts";
import {
	cleanText,
	matchesDomains,
	recencyStartDate,
	type SearchProvider,
	type SearchRequest,
	type SearchResult,
	toIsoDate,
} from "./types.ts";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MCP_ADVANCED_TOOL = "web_search_advanced_exa";
const MCP_BASIC_TOOL = "web_search_exa";

interface ExaResult {
	title?: unknown;
	url?: unknown;
	text?: unknown;
	publishedDate?: unknown;
	highlights?: unknown;
}

function searchArgs(request: SearchRequest): Record<string, unknown> {
	return {
		query: request.query,
		numResults: request.limit,
		...(request.include.length > 0 ? { includeDomains: request.include } : {}),
		...(request.exclude.length > 0 ? { excludeDomains: request.exclude } : {}),
		...(request.recency ? { startPublishedDate: recencyStartDate(request.recency) } : {}),
	};
}

function toResults(results: ExaResult[], request: SearchRequest): SearchResult[] {
	const mapped: SearchResult[] = [];
	for (const item of results) {
		if (typeof item.url !== "string" || !matchesDomains(item.url, request)) continue;
		const highlights = Array.isArray(item.highlights)
			? item.highlights.filter((entry): entry is string => typeof entry === "string").join(" ")
			: "";
		mapped.push({
			title: cleanText(item.title, 200) || item.url,
			url: item.url,
			snippet: cleanText(highlights || item.text),
			publishedAt: toIsoDate(item.publishedDate),
			provider: "exa",
		});
	}
	return mapped.slice(0, request.limit);
}

/** One JSON-RPC tool call over the hosted MCP endpoint; the reply is an SSE frame. */
async function callMcp(
	tool: string,
	args: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string> {
	let body: string;
	try {
		body = await apiFetch(`${EXA_MCP_URL}?tools=${tool}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: tool, arguments: args },
			}),
			timeoutMs,
			signal,
			label: "Exa MCP search",
		});
	} catch (error) {
		if (error instanceof HttpError && error.status === 429) {
			throw new HttpError(429, "Exa's keyless endpoint is rate limited right now. Try another provider.");
		}
		throw error;
	}

	const frames = body.startsWith("{")
		? [body]
		: body
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim());
	for (const frame of frames) {
		if (!frame) continue;
		let message: {
			result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
			error?: { message?: string };
		};
		try {
			message = JSON.parse(frame);
		} catch {
			continue;
		}
		if (message.error) throw new Error(`Exa MCP error: ${message.error.message ?? "unknown"}`);
		const text = message.result?.content?.find((part) => part.type === "text" && part.text?.trim())?.text;
		if (message.result?.isError) throw new Error(text?.trim() || "Exa MCP returned an error");
		if (text) return text;
	}
	throw new Error("Exa MCP returned no content");
}

/** The basic tool answers in formatted text blocks rather than JSON. */
function parseTextBlocks(text: string): ExaResult[] {
	const results: ExaResult[] = [];
	for (const block of text.split(/(?=^Title: )/m)) {
		const url = /^URL: (.+)$/m.exec(block)?.[1]?.trim();
		if (!url) continue;
		const highlightsAt = block.indexOf("\nHighlights:\n");
		const textAt = block.indexOf("\nText: ");
		const body =
			textAt >= 0 ? block.slice(textAt + 7) : highlightsAt >= 0 ? block.slice(highlightsAt + 13) : "";
		const published = /^Published: (.+)$/m.exec(block)?.[1]?.trim();
		results.push({
			title: /^Title: (.+)$/m.exec(block)?.[1]?.trim(),
			url,
			text: body.replace(/\n---\s*$/, "").trim(),
			publishedDate: published === "N/A" ? undefined : published,
		});
	}
	return results;
}

async function searchExa(
	request: SearchRequest,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ExaResult[]> {
	try {
		const text = await callMcp(
			MCP_ADVANCED_TOOL,
			{ ...searchArgs(request), type: "auto", enableHighlights: true, textMaxCharacters: 600 },
			timeoutMs,
			signal,
		);
		const parsed = JSON.parse(text) as { results?: ExaResult[] };
		if (Array.isArray(parsed.results)) return parsed.results;
		return parseTextBlocks(text);
	} catch (error) {
		// Rate limiting is about the endpoint, not the tool: retrying the basic
		// tool would only spend the same budget again.
		if (error instanceof HttpError) throw error;
		// Not every deployment exposes the advanced tool; the basic one ignores
		// filters, which are re-applied client-side below.
		return parseTextBlocks(
			await callMcp(MCP_BASIC_TOOL, { query: request.query, numResults: request.limit }, timeoutMs, signal),
		);
	}
}

export const exaProvider: SearchProvider = {
	id: "exa",
	label: "Exa",

	/** Needs no credential, so it is the one provider that is always usable. */
	async isAvailable() {
		return true;
	},

	async search(request, env) {
		return toResults(await searchExa(request, env.config.timeoutMs, env.signal), request);
	},
};
