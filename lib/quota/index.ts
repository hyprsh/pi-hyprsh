/**
 * Quota dispatch.
 *
 * Only the selected model's provider is queried, so switching models never
 * shows another provider's numbers.
 */

import { fetchAnthropicQuota } from "./anthropic.ts";
import { fetchCodexQuota } from "./codex.ts";
import type { QuotaSnapshot } from "./types.ts";
import { fetchXaiQuota } from "./xai.ts";

export type { QuotaSnapshot, QuotaWindow } from "./types.ts";

const PROVIDERS: Record<string, () => Promise<QuotaSnapshot>> = {
	anthropic: fetchAnthropicQuota,
	"openai-codex": fetchCodexQuota,
	xai: fetchXaiQuota,
};

/** Returns null when the provider has no quota implementation. */
export async function fetchQuota(provider: string | undefined): Promise<QuotaSnapshot | null> {
	if (!provider) return null;
	const fetcher = PROVIDERS[provider];
	if (!fetcher) return null;
	return await fetcher();
}
