import { createHash } from 'node:crypto';

import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';
import type { Logger } from '../telemetry/logger.js';
import { silentLogger } from '../telemetry/logger.js';
import type { CacheEntry, CacheStore } from './cache-store.js';

export type { CacheEntry, CacheStore } from './cache-store.js';
export { isCacheEntry, MemoryCacheStore } from './cache-store.js';

/**
 * Response cache.
 *
 * The cache is not an optimisation here, it is a feature. `screen_companies`
 * over thirty suppliers makes four calls each; without a cache that is 120
 * requests against a 600-per-five-minutes budget, and running it twice in an
 * afternoon starts hitting 429s. Company data also barely moves — a profile
 * changes when something is filed, which for most companies is twice a year.
 *
 * Two layers: an in-memory LRU for the current process, and a `CacheStore` for
 * anything durable, so that a restart (which happens every time a host
 * reconnects a stdio server) does not throw the day's work away.
 *
 * The durable layer is an interface rather than the filesystem because the
 * filesystem is not available everywhere this now runs. `FileCacheStore` is
 * the Node implementation; a Worker supplies a KV-backed one. Passing no store
 * at all gives a memory-only cache, which is what the tests want.
 *
 * A note on sharing, since this cache is now reachable by more than one user
 * at a time: the Companies House register is public, and a profile fetched
 * with one API key is byte-for-byte the profile fetched with another. So the
 * cache is deliberately NOT partitioned by credential — partitioning it would
 * multiply upstream cost for no privacy gain, because there is no private data
 * in it to leak. Rate limit budgets *are* partitioned by credential, because
 * those genuinely do belong to whoever owns the key. See ADR 13.
 *
 * On revalidation: entries store an HTTP `ETag` when the API supplies one, and
 * a stale entry is revalidated with `If-None-Match`. Note that this is *not*
 * the `etag` field inside Companies House JSON payloads — that is a
 * resource-version marker in the body, not an HTTP validator, and using it as
 * one would silently produce wrong results. Where no HTTP ETag comes back the
 * cache degrades to plain TTL, which is the common case today.
 */

export type ResourceKind =
  | 'company-profile'
  | 'officers'
  | 'officer-appointments'
  | 'filing-history'
  | 'charges'
  | 'psc'
  | 'insolvency'
  | 'search'
  | 'other';

/**
 * Default freshness per resource, in milliseconds.
 *
 * These are judgements, not measurements, and they are configurable for that
 * reason. Filing history gets the shortest life because it is the section
 * that changes when anything happens; search results get an hour because a
 * newly incorporated company appearing an hour late is harmless, whereas a
 * missed charge is not.
 */
export const DEFAULT_TTLS: Record<ResourceKind, number> = {
  'company-profile': 24 * 60 * 60 * 1000,
  officers: 12 * 60 * 60 * 1000,
  'officer-appointments': 12 * 60 * 60 * 1000,
  'filing-history': 6 * 60 * 60 * 1000,
  charges: 24 * 60 * 60 * 1000,
  psc: 24 * 60 * 60 * 1000,
  insolvency: 24 * 60 * 60 * 1000,
  search: 60 * 60 * 1000,
  other: 60 * 60 * 1000
};

export type CacheLookup =
  | { state: 'fresh'; entry: CacheEntry }
  | { state: 'stale'; entry: CacheEntry }
  | { state: 'miss' };

export interface ResponseCacheOptions {
  /** Durable tier. Omit for a memory-only cache. */
  store?: CacheStore | undefined;
  enabled?: boolean;
  clock?: Clock;
  logger?: Logger;
  /** Maximum entries held in memory before the oldest are dropped. */
  memoryMax?: number;
}

export class ResponseCache {
  readonly #store: CacheStore | undefined;
  readonly #enabled: boolean;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #memoryMax: number;
  readonly #memory = new Map<string, CacheEntry>();

  constructor(options: ResponseCacheOptions = {}) {
    this.#store = options.store;
    this.#enabled = options.enabled ?? true;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? silentLogger;
    this.#memoryMax = options.memoryMax ?? 500;
  }

  static key(method: string, url: string): string {
    return createHash('sha256').update(`${method.toUpperCase()} ${url}`).digest('hex');
  }

  async get(key: string): Promise<CacheLookup> {
    if (!this.#enabled) return { state: 'miss' };

    const fromMemory = this.#memory.get(key);
    if (fromMemory !== undefined) return this.#classify(fromMemory);

    const entry = await this.#read(key);
    if (entry === undefined) return { state: 'miss' };

    this.#rememberInMemory(key, entry);
    return this.#classify(entry);
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    if (!this.#enabled) return;
    this.#rememberInMemory(key, entry);
    await this.#write(key, entry);
  }

  /** Marks an entry fresh again after a 304, without rewriting the body. */
  async refresh(key: string, entry: CacheEntry): Promise<void> {
    await this.set(key, { ...entry, storedAt: this.#clock.now() });
  }

  async clear(): Promise<void> {
    this.#memory.clear();
    if (this.#store === undefined) return;
    try {
      await this.#store.clear();
    } catch (error) {
      this.#logger.debug('cache clear failed', { error });
    }
  }

  get size(): number {
    return this.#memory.size;
  }

  #classify(entry: CacheEntry): CacheLookup {
    const age = this.#clock.now() - entry.storedAt;
    return age < entry.ttlMs ? { state: 'fresh', entry } : { state: 'stale', entry };
  }

  #rememberInMemory(key: string, entry: CacheEntry): void {
    // Re-insert so that Map iteration order tracks recency of write.
    this.#memory.delete(key);
    this.#memory.set(key, entry);
    while (this.#memory.size > this.#memoryMax) {
      const oldest = this.#memory.keys().next();
      if (oldest.done === true) break;
      this.#memory.delete(oldest.value);
    }
  }

  /**
   * A store that throws must not fail the request that touched it. Stores are
   * contractually failure-tolerant, but this server talks to a store it did
   * not write (KV, someone's filesystem), so the guarantee is enforced here
   * too rather than assumed.
   */
  async #read(key: string): Promise<CacheEntry | undefined> {
    if (this.#store === undefined) return undefined;
    try {
      return await this.#store.read(key);
    } catch (error) {
      this.#logger.debug('cache store read failed', { key, error });
      return undefined;
    }
  }

  async #write(key: string, entry: CacheEntry): Promise<void> {
    if (this.#store === undefined) return;
    try {
      await this.#store.write(key, entry);
    } catch (error) {
      this.#logger.debug('cache store write failed', { key, error });
    }
  }
}
