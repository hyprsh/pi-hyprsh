/**
 * In-memory TTL cache.
 *
 * Process-local by design: nothing web-related is written to disk, so a search
 * or a fetched page never outlives the session.
 */

interface Entry<T> {
	value: T;
	expiresAt: number;
}

export class TtlCache<T> {
	private readonly entries = new Map<string, Entry<T>>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;

	constructor(ttlMs: number, maxEntries = 200) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
	}

	get(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= Date.now()) {
			this.entries.delete(key);
			return undefined;
		}
		// Refresh insertion order so the oldest eviction below stays meaningful.
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}

	set(key: string, value: T): void {
		this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.entries.delete(oldest.value);
		}
	}
}
