/**
 * xAI SuperGrok subscription usage.
 *
 * GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 * Reads `config.creditUsagePercent`, `config.currentPeriod.type`, and its reset boundary.
 *
 * Undocumented endpoint; verified live against a SuperGrok subscription. xAI
 * publishes no REST API for consumer subscription allowance, and the grok.com
 * gRPC-web endpoint behind Settings → Usage rejects OAuth tokens; this CLI
 * proxy accepts the same OAuth token pi already stores.
 *
 * Endpoint and response shape learned from slkiser/opencode-quota (PR #165).
 */

import { fetchJson, readAuth, safeError, toPercent, toResetAt } from "./http.ts";
import { emptySnapshot, type QuotaSnapshot } from "./types.ts";

const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

function periodLabel(type: unknown): string {
	const raw = typeof type === "string" ? type.toUpperCase() : "";
	if (raw.includes("WEEK")) return "wk";
	if (raw.includes("MONTH")) return "mo";
	if (raw.includes("DAY")) return "24h";
	return "quota";
}

export async function fetchXaiQuota(): Promise<QuotaSnapshot> {
	const auth = readAuth("xai");
	if (!auth?.access) return emptySnapshot("no-auth");
	if (auth.expires && auth.expires < Date.now()) return emptySnapshot("expired");

	try {
		const data = (await fetchJson(CREDITS_URL, {
			Authorization: `Bearer ${auth.access}`,
			Accept: "application/json",
		})) as { config?: Record<string, unknown> } | null;

		const config = data?.config;
		if (!config || typeof config !== "object") return emptySnapshot("unavailable");

		const period = config.currentPeriod as Record<string, unknown> | undefined;
		if (!period?.type) return emptySnapshot("unavailable");

		// Protobuf JSON omits zero-valued fields, so an absent percentage
		// alongside a current period means 0% used, not missing data.
		const percent = "creditUsagePercent" in config ? toPercent(config.creditUsagePercent) : 0;
		if (percent === null) return emptySnapshot("unavailable");

		const resetAt = toResetAt(period.end ?? period.reset_at ?? config.billingPeriodEnd);
		return { windows: [{ label: periodLabel(period.type), percent, resetAt }], fetchedAt: Date.now() };
	} catch (error) {
		return emptySnapshot(safeError(error));
	}
}
