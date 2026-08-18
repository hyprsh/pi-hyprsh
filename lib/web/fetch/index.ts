/**
 * web_fetch pipeline: validate, fetch, extract, bound.
 *
 * Direct extraction is always tried first. Only when a page is blocked or has
 * no server-rendered content does this fall back to a configured remote
 * extractor (Jina by default). No headless browser is involved.
 */

import { TtlCache } from "../cache.ts";
import type { WebFetchConfig } from "../config.ts";
import { apiFetch, BlockedError, HttpError, safeFetch, withRetry } from "../http.ts";
import {
	decodeBody,
	type ExtractionMethod,
	extractHtml,
	extractPdf,
	extractText,
	isHtml,
	isTextual,
	mimeOf,
} from "./extract.ts";

export interface FetchOutcome {
	/** URL after redirects. */
	url: string;
	title?: string;
	mime: string;
	method: ExtractionMethod;
	content: string;
	chars: number;
	truncated: boolean;
	bytes: number;
}

/** Statuses where a bot wall, not a broken URL, is the likely cause. */
const EXTRACTOR_STATUS = new Set([401, 402, 403, 405, 406, 429, 451, 503]);

let cache: TtlCache<FetchOutcome> | undefined;

function cached(config: WebFetchConfig): TtlCache<FetchOutcome> {
	if (!cache) cache = new TtlCache<FetchOutcome>(config.cacheTtlMs, 50);
	return cache;
}

function bound(outcome: Omit<FetchOutcome, "chars" | "truncated">, maxChars: number): FetchOutcome {
	const truncated = outcome.content.length > maxChars;
	const content = truncated ? outcome.content.slice(0, maxChars) : outcome.content;
	return { ...outcome, content, chars: content.length, truncated };
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Jina-style remote extractor: GET <base>/<url>, Markdown back. */
async function remoteExtract(url: string, config: WebFetchConfig, signal?: AbortSignal): Promise<string> {
	if (!config.extractorUrl) throw new Error("no remote extractor configured");
	const headers: Record<string, string> = { Accept: "text/plain" };
	if (config.extractorApiKey) headers.Authorization = `Bearer ${config.extractorApiKey}`;
	return apiFetch(`${config.extractorUrl}/${url}`, {
		headers,
		timeoutMs: config.timeoutMs,
		maxBytes: config.maxBytes,
		signal,
		label: "Remote extractor",
	});
}

export async function fetchUrl(
	target: string,
	options: { config: WebFetchConfig; maxChars?: number; signal?: AbortSignal },
): Promise<FetchOutcome> {
	const { config, signal } = options;
	const maxChars = Math.min(options.maxChars ?? config.maxChars, config.maxChars);
	const key = `${target}\u0000${maxChars}`;
	const store = cached(config);
	const hit = store.get(key);
	if (hit) return hit;

	const outcome = await extractOnce(target, config, maxChars, signal);
	store.set(key, outcome);
	return outcome;
}

async function extractOnce(
	target: string,
	config: WebFetchConfig,
	maxChars: number,
	signal?: AbortSignal,
): Promise<FetchOutcome> {
	let fetched: Awaited<ReturnType<typeof safeFetch>>;
	try {
		fetched = await withRetry(
			() =>
				safeFetch(target, {
					headers: {
						"User-Agent": config.userAgent,
						Accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8",
						"Accept-Language": "en,*;q=0.5",
					},
					timeoutMs: config.timeoutMs,
					maxBytes: config.maxBytes,
					maxRedirects: config.maxRedirects,
					signal,
				}),
			{ retries: config.retries, signal },
		);
	} catch (error) {
		// A blocked address is a policy decision and must never be routed around.
		if (error instanceof BlockedError) throw error;
		if (error instanceof HttpError && EXTRACTOR_STATUS.has(error.status) && config.extractorUrl) {
			return bound(await viaExtractor(target, config, signal), maxChars);
		}
		throw error;
	}

	const { response, body, finalUrl } = fetched;
	if (!response.ok) {
		if (EXTRACTOR_STATUS.has(response.status) && config.extractorUrl) {
			return bound(await viaExtractor(target, config, signal), maxChars);
		}
		// An error page's markup is noise; only a plain-text explanation is worth quoting.
		const detail = decodeBody(body, response.headers.get("content-type")).trim();
		const quoted = detail.startsWith("<") ? "" : detail.slice(0, 200);
		throw new HttpError(
			response.status,
			`HTTP ${response.status} fetching ${finalUrl}${quoted ? `: ${quoted}` : ""}`,
		);
	}

	const contentType = response.headers.get("content-type");
	const mime = mimeOf(contentType, body);

	if (isHtml(mime)) {
		const html = decodeBody(body, contentType);
		const extracted = await extractHtml(html, finalUrl);
		// A client-rendered page yields almost nothing; that is what the extractor is for.
		if (extracted.content.length < 200 && config.extractorUrl) {
			const viaRemote = await viaExtractor(target, config, signal).catch(() => undefined);
			if (viaRemote && viaRemote.content.length > extracted.content.length) {
				return bound({ ...viaRemote, url: finalUrl, title: extracted.title ?? viaRemote.title }, maxChars);
			}
		}
		if (!extracted.content) {
			throw new Error(
				`No readable content at ${finalUrl}. The page is probably client-rendered; configure web.fetch.extractorUrl to extract it remotely.`,
			);
		}
		return bound({ ...extracted, url: finalUrl, mime, bytes: body.byteLength }, maxChars);
	}

	if (mime === "application/pdf") {
		const extracted = await extractPdf(body);
		return bound({ ...extracted, url: finalUrl, mime, bytes: body.byteLength }, maxChars);
	}

	if (isTextual(mime)) {
		const extracted = extractText(body, contentType, mime);
		return bound({ ...extracted, url: finalUrl, mime, bytes: body.byteLength }, maxChars);
	}

	throw new Error(
		`Unsupported content type ${mime} at ${finalUrl} (${formatBytes(body.byteLength)}). Only HTML, PDF, text, JSON and XML can be extracted.`,
	);
}

async function viaExtractor(
	target: string,
	config: WebFetchConfig,
	signal?: AbortSignal,
): Promise<Omit<FetchOutcome, "chars" | "truncated">> {
	const content = (await remoteExtract(target, config, signal)).trim();
	if (!content) throw new Error(`Remote extractor returned no content for ${target}`);
	const title = /^Title:\s*(.+)$/m.exec(content.slice(0, 500))?.[1]?.trim();
	return { url: target, title, mime: "text/markdown", method: "remote", content, bytes: content.length };
}
