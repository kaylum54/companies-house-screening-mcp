/**
 * The durable tier behind the response cache.
 *
 * `ResponseCache` keeps its own in-memory LRU; everything below that is a
 * `CacheStore`. The interface exists so that the cache — which is a feature
 * here rather than an optimisation, see the note at the top of `cache.ts` —
 * can be backed by whatever the deployment actually has. A local stdio server
 * gets the filesystem; a Worker gets KV; a test gets memory or nothing.
 *
 * The rule this enforces is that nothing in the portable core imports
 * `node:fs`. Cloudflare Workers have no filesystem, and the moment the cache
 * reaches for one directly, the whole server stops being deployable there.
 * `tests/runtime-portability.test.ts` checks that rule mechanically rather
 * than trusting anyone to remember it.
 *
 * Every method is failure-tolerant by contract: a store that cannot read,
 * write or clear must degrade to a miss rather than throw. A broken cache
 * makes the server slower and more expensive. It must never make it wrong,
 * and it must never fail a request that Companies House would have answered.
 */

export interface CacheEntry {
  body: unknown;
  etag?: string | undefined;
  storedAt: number;
  ttlMs: number;
}

export interface CacheStore {
  /** Resolves to `undefined` for a miss, an unreadable entry, or a corrupt one. */
  read(key: string): Promise<CacheEntry | undefined>;
  write(key: string, entry: CacheEntry): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Validates anything coming back from a store.
 *
 * A cache is persistent state written by an older version of this code, and
 * possibly by a different one: a KV namespace outlives any single deploy.
 * Parsing it as trusted input is how a schema change becomes a runtime crash
 * months later, so every store runs its reads through here.
 */
export function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['storedAt'] === 'number' &&
    typeof candidate['ttlMs'] === 'number' &&
    'body' in candidate
  );
}

/**
 * In-process store, for tests and for any deployment with no durable tier
 * worth the trouble.
 *
 * Note that this is *not* the same as `ResponseCache`'s memory tier: that one
 * is an LRU sitting in front of the store. Using this as the store gives a
 * cache that is entirely in memory, which is the correct configuration for a
 * test and an acceptable one for a single short-lived process.
 */
export class MemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, CacheEntry>();

  async read(key: string): Promise<CacheEntry | undefined> {
    return this.#entries.get(key);
  }

  async write(key: string, entry: CacheEntry): Promise<void> {
    this.#entries.set(key, entry);
  }

  async clear(): Promise<void> {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
