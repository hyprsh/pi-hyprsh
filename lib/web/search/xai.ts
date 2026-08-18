/**
 * xAI search through the Agent Tools API.
 *
 * Same shape as OpenAI's Responses API, so the output parsing is shared. Auth
 * comes from pi's model registry first, which lets a SuperGrok / X Premium
 * subscription pay for the search without an API key.
 *
 * xAI's older Live Search (`search_parameters` on /v1/chat/completions) is gone
 * and answers 410. Do not add it back. The request body is kept minimal because
 * that is the shape verified against a live account; an unknown field costs the
 * whole search with a 400.
 */

import { apiFetch } from "../http.ts";
import { extractSources, parseResponseOutput } from "./openai.ts";
import type { ProviderEnv, SearchProvider, SearchRequest } from "./types.ts";

const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
/**
 * Preference list, not an assumption: an id the registry does not know is skipped.
 *
 * Ordered by measured latency for this workload, not by version number. A
 * search is one forced tool call and a discarded sentence of prose, so the
 * newest model is the wrong default: against the same query, grok-4.3 answered
 * in 8.8-10.8s, grok-4.5 in 11.2-16.5s and grok-4.6 in 28.0-29.6s, all with the
 * same number of sources. Do not promote grok-4.6 here without re-measuring.
 */
const MODEL_CANDIDATES = ["grok-4.3", "grok-4.5", "grok-build-0.1"];

interface Auth {
	apiKey: string;
	model: string;
	headers: Record<string, string>;
}

async function resolveAuth(env: ProviderEnv): Promise<Auth | undefined> {
	const override = env.config.xaiModel;
	for (const id of override ? [override, ...MODEL_CANDIDATES] : MODEL_CANDIDATES) {
		try {
			const model = env.ctx.modelRegistry.find("xai", id);
			if (!model) continue;
			const resolved = await env.ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!resolved.ok || !resolved.apiKey) continue;
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(resolved.headers ?? {})) {
				if (typeof value === "string") headers[name] = value;
			}
			return { apiKey: resolved.apiKey, model: override ?? id, headers };
		} catch {
			// Fall through to the next candidate.
		}
	}
	if (!env.config.xaiApiKey) return undefined;
	return { apiKey: env.config.xaiApiKey, model: override ?? (MODEL_CANDIDATES[0] as string), headers: {} };
}

/** Filters are folded into the prompt: xAI's filter field names are unverified. */
function buildInput(request: SearchRequest): string {
	const lines = [
		"Call the web_search tool for the query below and cite every source you used.",
		"Keep the prose to one sentence: the citations are what matters.",
	];
	if (request.recency) lines.push(`Prefer sources from the past ${request.recency}.`);
	lines.push(`Aim for about ${request.limit} distinct sources.`);
	if (request.include.length > 0) lines.push(`Only use sources from: ${request.include.join(", ")}.`);
	if (request.exclude.length > 0) lines.push(`Do not use sources from: ${request.exclude.join(", ")}.`);
	return `${lines.join(" ")}\n\n${request.query}`;
}

export const xaiProvider: SearchProvider = {
	id: "xai",
	label: "xAI",

	async isAvailable(env) {
		return (await resolveAuth(env)) !== undefined;
	},

	async search(request, env) {
		const auth = await resolveAuth(env);
		if (!auth) {
			throw new Error(
				"xAI search is unavailable. Sign in with /login for a SuperGrok or X Premium subscription, set XAI_API_KEY, or configure web.search.xaiApiKey.",
			);
		}

		const body = await apiFetch(XAI_RESPONSES_URL, {
			method: "POST",
			headers: {
				...auth.headers,
				Authorization: `Bearer ${auth.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: auth.model,
				input: buildInput(request),
				tools: [{ type: "web_search" }],
			}),
			timeoutMs: env.config.timeoutMs,
			signal: env.signal,
			label: "xAI web search",
		});

		return extractSources(parseResponseOutput(body), "xai").slice(0, request.limit);
	},
};
