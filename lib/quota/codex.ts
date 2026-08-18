/**
 * OpenAI Codex subscription usage.
 *
 * GET https://chatgpt.com/backend-api/wham/usage
 * Reads `rate_limit.primary_window` and `rate_limit.secondary_window`, including reset timestamps.
 *
 * Undocumented endpoint; verified live against a Codex subscription. The window
 * length varies by plan, so each window is labelled from `limit_window_seconds`
 * rather than from the field it arrived in. The response also carries account
 * identity and credit balance, none of which is read here.
 */

import {
	fetchJson,
	readAuth,
	resetAtAfterSeconds,
	safeError,
	toPercent,
	toResetAt,
	windowLabel,
} from "./http.ts";
import { emptySnapshot, type QuotaSnapshot, type QuotaWindow } from "./types.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

interface RateWindow {
	used_percent?: unknown;
	limit_window_seconds?: unknown;
	reset_at?: unknown;
	reset_after_seconds?: unknown;
}

export async function fetchCodexQuota(): Promise<QuotaSnapshot> {
	const auth = readAuth("openai-codex");
	if (!auth?.access) return emptySnapshot("no-auth");

	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.access}`,
		Accept: "application/json",
	};
	if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

	try {
		const data = (await fetchJson(USAGE_URL, headers)) as {
			rate_limit?: { primary_window?: RateWindow | null; secondary_window?: RateWindow | null };
		} | null;

		const windows: QuotaWindow[] = [];
		for (const source of [data?.rate_limit?.primary_window, data?.rate_limit?.secondary_window]) {
			if (!source) continue;
			const percent = toPercent(source.used_percent);
			if (percent === null) continue;
			const resetAt = toResetAt(source.reset_at) ?? resetAtAfterSeconds(source.reset_after_seconds);
			windows.push({ label: windowLabel(Number(source.limit_window_seconds)), percent, resetAt });
		}

		return { windows, fetchedAt: Date.now() };
	} catch (error) {
		return emptySnapshot(safeError(error));
	}
}
