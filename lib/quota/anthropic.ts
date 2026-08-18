/**
 * Anthropic subscription usage.
 *
 * GET https://api.anthropic.com/api/oauth/usage
 * Reads `five_hour.utilization` / `resets_at` and `seven_day.utilization` / `resets_at`.
 *
 * Undocumented endpoint; verified live against a Claude subscription.
 * Endpoint and response shape learned from @juanbenjumea/pi-dynamic-footer (MIT).
 */

import { fetchJson, readAuth, safeError, toPercent, toResetAt } from "./http.ts";
import { emptySnapshot, type QuotaSnapshot, type QuotaWindow } from "./types.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export async function fetchAnthropicQuota(): Promise<QuotaSnapshot> {
	const token = readAuth("anthropic")?.access;
	if (!token) return emptySnapshot("no-auth");

	try {
		const data = (await fetchJson(USAGE_URL, {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		})) as Record<string, { utilization?: unknown; resets_at?: unknown }> | null;

		const windows: QuotaWindow[] = [];
		for (const [label, key] of [
			["5h", "five_hour"],
			["wk", "seven_day"],
		] as const) {
			const source = data?.[key];
			const percent = toPercent(source?.utilization);
			if (percent !== null) windows.push({ label, percent, resetAt: toResetAt(source?.resets_at) });
		}

		return { windows, fetchedAt: Date.now() };
	} catch (error) {
		return emptySnapshot(safeError(error));
	}
}
