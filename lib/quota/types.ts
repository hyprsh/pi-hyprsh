/**
 * Shared quota types.
 *
 * A window is one rolling allowance period with a used percentage. Providers
 * differ in how many they expose, so the footer renders whatever is returned.
 */

export interface QuotaWindow {
	/** Short label derived from the window length, e.g. "5h", "wk", "mo". */
	label: string;
	/** Percentage of the allowance already used, 0-100. */
	percent: number;
	/** Absolute reset time in milliseconds, when the provider reports one. */
	resetAt?: number;
}

export interface QuotaSnapshot {
	windows: QuotaWindow[];
	/** Short reason when nothing could be fetched. Rendered instead of numbers. */
	error?: string;
	fetchedAt: number;
}

export function emptySnapshot(error: string): QuotaSnapshot {
	return { windows: [], error, fetchedAt: Date.now() };
}
