/**
 * Shared HTTP and credential helpers for quota providers.
 *
 * Every provider here talks to an undocumented subscription endpoint using a
 * token from pi's auth store. Tokens are used as request headers only: they are
 * never logged, rendered, cached to disk or included in error strings.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../config.ts";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface AuthEntry {
	access?: string;
	accountId?: string;
	expires?: number;
}

/** Read one provider entry from pi's auth store. */
export function readAuth(provider: string): AuthEntry | undefined {
	let auth: Record<string, unknown>;
	try {
		auth = JSON.parse(readFileSync(join(agentDir(), "auth.json"), "utf-8"));
	} catch {
		return undefined;
	}

	const entry = auth?.[provider];
	if (typeof entry === "string") return { access: normalizeToken(entry) };
	if (!entry || typeof entry !== "object") return undefined;

	const record = entry as Record<string, unknown>;
	return {
		access: normalizeToken(record.access),
		accountId: typeof record.accountId === "string" ? record.accountId : undefined,
		expires: typeof record.expires === "number" ? record.expires : undefined,
	};
}

function normalizeToken(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	// Never execute a shell credential from auth.json.
	if (trimmed.startsWith("!")) return undefined;
	return trimmed;
}

/** Read a response body with a hard size cap. */
async function readLimited(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("too-large");

	const reader = response.body?.getReader();
	if (!reader) return "";

	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("too-large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/** GET JSON with a timeout, a size cap and no redirect following. */
export async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers,
			// Never follow a redirect while an authorization header is attached.
			redirect: "error",
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return JSON.parse(await readLimited(response));
	} finally {
		clearTimeout(timer);
	}
}

/** Endpoints report utilization as either a 0-1 ratio or a 0-100 percentage. */
export function toPercent(value: unknown): number | null {
	const n = Number(value);
	if (!Number.isFinite(n)) return null;
	const scaled = n >= 0 && n <= 1 ? n * 100 : n;
	return Math.max(0, Math.min(100, scaled));
}

/** Normalize an ISO date or Unix timestamp to epoch milliseconds. */
export function toResetAt(value: unknown): number | undefined {
	let timestamp: number;
	if (typeof value === "number") {
		timestamp = value;
	} else if (typeof value === "string") {
		const text = value.trim();
		if (!text) return undefined;
		const numeric = Number(text);
		timestamp = Number.isFinite(numeric) ? numeric : Date.parse(text);
	} else {
		return undefined;
	}

	if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
	const milliseconds = timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
	return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

/** Convert a provider's relative reset duration in seconds to epoch milliseconds. */
export function resetAtAfterSeconds(value: unknown, now = Date.now()): number | undefined {
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	if (typeof value === "string" && !value.trim()) return undefined;
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) return undefined;
	const resetAt = now + seconds * 1000;
	return Number.isFinite(resetAt) ? resetAt : undefined;
}

/** Never let a credential or a response body leak into an error string. */
export function safeError(error: unknown): string {
	if (error instanceof Error && /^HTTP \d+$/.test(error.message)) return error.message;
	if (error instanceof Error && error.message === "too-large") return "too-large";
	if (error instanceof DOMException && error.name === "AbortError") return "timeout";
	return "unavailable";
}

const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * Label a window by its length rather than by the field it arrived in.
 * Codex in particular returns a weekly allowance in `primary_window`.
 */
export function windowLabel(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return "quota";
	if (seconds === 5 * HOUR) return "5h";
	if (seconds === 7 * DAY) return "wk";
	if (seconds >= 28 * DAY && seconds <= 31 * DAY) return "mo";
	if (seconds < DAY) return `${Math.round(seconds / HOUR)}h`;
	return `${Math.round(seconds / DAY)}d`;
}
