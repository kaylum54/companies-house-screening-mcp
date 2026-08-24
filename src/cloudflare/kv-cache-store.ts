import type { CacheEntry, CacheStore } from '../http/cache-store.js';
import { isCacheEntry } from '../http/cache-store.js';
import type { Logger } from '../telemetry/logger.js';
import { silentLogger } from '../telemetry/logger.js';
import type { KVNamespace } from './types.js';

/**
 * KV-backed cache, the Workers equivalent of the filesystem store.
 *
 * KV is eventually consistent, which would be a problem for state that must be
 * correct and is fine for this: a stale read is a cache miss or a slightly old
 * profile, and `ResponseCache` already classifies entries by age and
 * revalidates them. Nothing here is authoritative — the rate-limit window,
 * which *is* authoritative, deliberately lives in a Durable Object instead.
 */

export interface KvCacheStoreOptions {
  namespace: KVNamespace;
  logger?: Logger;
  /**
   * How long KV should keep an entry, in seconds.
   *
   * Independent of the per-resource TTLs in `DEFAULT_TTLS`: those decide when
   * an entry stops being *fresh*, while this decides when it stops *existing*.
   * The gap between them is deliberate, because a stale entry is still worth
   * having — it can be revalidated with an ETag, and it is what gets served if
   * Companies House is down.
   */
  expirationTtlSeconds?: number;
}

/** A week. Long enough to keep stale entries useful, short enough to bound storage. */
const DEFAULT_EXPIRATION_SECONDS = 7 * 24 * 60 * 60;

/** KV's own floor: it rejects anything shorter. */
const MINIMUM_EXPIRATION_SECONDS = 60;

export class KvCacheStore implements CacheStore {
  readonly #kv: KVNamespace;
  readonly #logger: Logger;
  readonly #ttlSeconds: number;

  constructor(options: KvCacheStoreOptions) {
    this.#kv = options.namespace;
    this.#logger = options.logger ?? silentLogger;
    this.#ttlSeconds = Math.max(
      MINIMUM_EXPIRATION_SECONDS,
      options.expirationTtlSeconds ?? DEFAULT_EXPIRATION_SECONDS
    );
  }

  async read(key: string): Promise<CacheEntry | undefined> {
    try {
      const raw = await this.#kv.get(key, 'text');
      if (raw === null) return undefined;

      const parsed: unknown = JSON.parse(raw);
      if (!isCacheEntry(parsed)) {
        // A KV namespace outlives any single deploy, so entries written by an
        // older shape of this code are a normal occurrence, not a crash.
        this.#logger.debug('cache entry ignored: unexpected shape', { key });
        return undefined;
      }
      return parsed;
    } catch (error) {
      this.#logger.debug('cache read failed', { key, error });
      return undefined;
    }
  }

  async write(key: string, entry: CacheEntry): Promise<void> {
    try {
      await this.#kv.put(key, JSON.stringify(entry), { expirationTtl: this.#ttlSeconds });
    } catch (error) {
      this.#logger.debug('cache write failed', { key, error });
    }
  }

  /**
   * Not supported: KV offers no bulk delete, and enumerating a namespace to
   * empty it is neither cheap nor atomic. Entries expire on their own TTL.
   * Declared rather than omitted so the interface stays honest about it.
   */
  async clear(): Promise<void> {
    this.#logger.debug('cache clear is a no-op on KV; entries expire by TTL');
  }
}
