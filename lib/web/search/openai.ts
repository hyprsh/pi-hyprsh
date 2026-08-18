/**
 * OpenAI / Codex search.
 *
 * The search runs inside OpenAI's hosted `web_search` tool, so a Codex
 * subscription resolved through pi's model registry pays for it and no API key
 * has to be configured at all. Only the sources are kept: the model's prose is
 * discarded, because this tool returns results, not answers.
 */

import type { SearchProviderId } from "../config.ts";
import { apiFetch } from "../http.ts";
import {
	cleanText,
	type ProviderEnv,
	type SearchProvider,
	type SearchRequest,
	type SearchResult,
} from "./types.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_MODEL = "gpt-5.6-terra";
const REGISTRY_PROVIDERS = ["openai-codex", "openai"] as const;
/** Price tiers are excluded: a search does not need them and they cost more. */
const EXCLUDED_SEGMENTS = new Set(["pro", "ultra"]);

interface Auth {
	apiKey: string;
	model: string;
	headers: Record<string, string>;
	url: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const [, payload] = token.split(".");
	if (!payload || token.split(".").length !== 3) return undefined;
	try {
		const padded = payload
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(payload.length / 4) * 4, "=");
		const parsed: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function codexAccountId(token: string): string | undefined {
	const claim = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
	if (!claim || typeof claim !== "object") return undefined;
	const id = (claim as Record<string, unknown>).chatgpt_account_id;
	return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function pickModel(ids: string[]): string | undefined {
	const candidates = ids
		.filter((id) => !id.split("-").some((segment) => EXCLUDED_SEGMENTS.has(segment)))
		.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	return (
		candidates.find((id) => id.includes("terra")) ??
		candidates.find((id) => /^gpt-\d+(\.\d+)?$/.test(id)) ??
		candidates[0]
	);
}

async function resolveAuth(env: ProviderEnv): Promise<Auth | undefined> {
	const override = env.config.openaiModel;
	for (const provider of REGISTRY_PROVIDERS) {
		try {
			const models = env.ctx.modelRegistry.getAll().filter((model) => model.provider === provider);
			const chosen = override ?? pickModel(models.map((model) => model.id));
			const model = models.find((entry) => entry.id === chosen) ?? models[0];
			if (!model) continue;
			const resolved = await env.ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!resolved.ok || !resolved.apiKey) continue;
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(resolved.headers ?? {})) {
				if (typeof value === "string") headers[name] = value;
			}
			return { apiKey: resolved.apiKey, model: chosen ?? model.id, headers, url: OPENAI_RESPONSES_URL };
		} catch {
			// A registry that cannot answer for this provider is simply not available.
		}
	}
	if (!env.config.openaiApiKey) return undefined;
	return {
		apiKey: env.config.openaiApiKey,
		model: override ?? DEFAULT_MODEL,
		headers: {},
		url: OPENAI_RESPONSES_URL,
	};
}

function buildInstructions(request: SearchRequest): string {
	const lines = [
		"Call the web_search tool for the user's query.",
		"Answer in at most two sentences and cite every source you consulted inline, so each one appears as a citation with its page title.",
	];
	if (request.recency) lines.push(`Prefer sources from the past ${request.recency}.`);
	lines.push(`Aim for about ${request.limit} distinct sources.`);
	return lines.join(" ");
}

function buildTool(request: SearchRequest): Record<string, unknown> {
	const filters: Record<string, string[]> = {};
	if (request.include.length > 0) filters.allowed_domains = request.include.slice(0, 100);
	if (request.exclude.length > 0) filters.blocked_domains = request.exclude.slice(0, 100);
	return Object.keys(filters).length > 0 ? { type: "web_search", filters } : { type: "web_search" };
}

/** The Codex endpoint only answers as a stream, so both endpoints are read as SSE. */
export function parseResponseOutput(body: string): unknown[] {
	const trimmed = body.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as { output?: unknown };
			return Array.isArray(parsed.output) ? parsed.output : [];
		} catch {
			return [];
		}
	}

	const items: unknown[] = [];
	let completed: unknown[] | undefined;
	for (const line of trimmed.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") continue;
		try {
			const event = JSON.parse(data) as { type?: string; item?: unknown; response?: { output?: unknown } };
			if (event.type === "response.output_item.done" && event.item) items.push(event.item);
			if (
				(event.type === "response.completed" || event.type === "response.done") &&
				Array.isArray(event.response?.output)
			) {
				completed = event.response.output;
			}
		} catch {
			// A single malformed frame must not lose the rest of the stream.
		}
	}
	return completed?.length ? completed : items;
}

/**
 * Sources come from the tool call itself and from citations on the answer text.
 * Neither is complete on its own: the tool call knows every page that was
 * visited, the citations carry the page titles. They are merged per URL.
 */
export function extractSources(output: unknown[], provider: SearchProviderId): SearchResult[] {
	const byUrl = new Map<string, SearchResult>();

	const add = (url: unknown, title: unknown, snippet: unknown, published: unknown) => {
		if (typeof url !== "string" || !url.trim()) return;
		let clean = url.trim();
		try {
			const parsed = new URL(clean);
			if (parsed.searchParams.get("utm_source") === "openai") parsed.searchParams.delete("utm_source");
			clean = parsed.toString();
		} catch {
			return;
		}
		const existing = byUrl.get(clean);
		const entry: SearchResult = existing ?? { title: clean, url: clean, snippet: "", provider };
		// xAI labels some citations "1", "2", … — a footnote number is not a title.
		const cleanTitle = cleanText(title, 200);
		const usableTitle = cleanTitle.length >= 3 && !/^\d+$/.test(cleanTitle) ? cleanTitle : "";
		if (usableTitle && entry.title === clean) entry.title = usableTitle;
		const cleanSnippet = cleanText(snippet);
		if (cleanSnippet.length > entry.snippet.length) entry.snippet = cleanSnippet;
		if (!entry.publishedAt && typeof published === "string") entry.publishedAt = published;
		byUrl.set(clean, entry);
	};

	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		const entry = item as Record<string, unknown>;
		if (entry.type === "web_search_call") {
			const action = entry.action as Record<string, unknown> | undefined;
			for (const group of [action?.sources, entry.sources, entry.results]) {
				if (!Array.isArray(group)) continue;
				for (const source of group) {
					if (!source || typeof source !== "object") continue;
					const record = source as Record<string, unknown>;
					add(
						record.url ?? record.source_website_url,
						record.title ?? record.caption,
						record.snippet ?? record.description ?? record.text,
						record.published_at ?? record.date,
					);
				}
			}
		}
		if (entry.type !== "message" || !Array.isArray(entry.content)) continue;
		for (const part of entry.content) {
			if (!part || typeof part !== "object") continue;
			const annotations = (part as Record<string, unknown>).annotations;
			if (!Array.isArray(annotations)) continue;
			for (const annotation of annotations) {
				if (!annotation || typeof annotation !== "object") continue;
				const record = annotation as Record<string, unknown>;
				if (record.type !== "url_citation") continue;
				add(record.url, record.title, undefined, undefined);
			}
		}
	}
	return [...byUrl.values()];
}

export const openaiProvider: SearchProvider = {
	id: "openai",
	label: "OpenAI",

	async isAvailable(env) {
		return (await resolveAuth(env)) !== undefined;
	},

	async search(request, env) {
		const auth = await resolveAuth(env);
		if (!auth) {
			throw new Error(
				"OpenAI search is unavailable. Sign in with /login for a Codex subscription, set OPENAI_API_KEY, or configure web.search.openaiApiKey.",
			);
		}

		const isCodex =
			auth.headers["chatgpt-account-id"] !== undefined ||
			decodeJwtPayload(auth.apiKey)?.["https://api.openai.com/auth"] !== undefined;
		const headers: Record<string, string> = {
			...auth.headers,
			Authorization: `Bearer ${auth.apiKey}`,
			"Content-Type": "application/json",
			"OpenAI-Beta": "responses=experimental",
		};
		if (isCodex) {
			const accountId = codexAccountId(auth.apiKey);
			if (accountId) headers["chatgpt-account-id"] = accountId;
			headers.originator = "pi";
		}

		const body = await apiFetch(isCodex ? CODEX_RESPONSES_URL : auth.url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: auth.model,
				instructions: buildInstructions(request),
				input: [{ role: "user", content: [{ type: "input_text", text: request.query }] }],
				tools: [buildTool(request)],
				include: ["web_search_call.action.sources"],
				tool_choice: "required",
				parallel_tool_calls: true,
				store: false,
				stream: true,
			}),
			timeoutMs: env.config.timeoutMs,
			signal: env.signal,
			label: "OpenAI web search",
		});

		return extractSources(parseResponseOutput(body), "openai").slice(0, request.limit);
	},
};
