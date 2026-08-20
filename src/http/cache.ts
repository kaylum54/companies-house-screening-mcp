import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';
import type { Logger } from '../telemetry/logger.js';
import { silentLogger } from '../telemetry/logger.js';

/**
 * Response cache.
 *
 * The cache is not an optimisation here, it is a feature. `screen_companies`
 * over thirty suppliers makes four calls each; without a cache that is 120
 * requests against a 600-per-five-minutes budget, and running it twice in an
 * afternoon starts hitting 429s. Company data also barely moves — a profile
 * changes when something is filed, which for most companies is twice a year.
 *
 * Two layers: an in-memory map for the current process, and a disk layer so
 * that restarting the server (which happens every time a host reconnects)
 * does not throw the day's work away.
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

export interface CacheEntry {
  body: unknown;
  etag?: string | undefined;
  storedAt: number;
  ttlMs: number;
}

export type CacheLookup =
  | { state: 'fresh'; entry: CacheEntry }
  | { state: 'stale'; entry: CacheEntry }
  | { state: 'miss' };

export interface ResponseCacheOptions {
  dir: string;
  enabled?: boolean;
  clock?: Clock;
  logger?: Logger;
  /** Maximum entries held in memory before the oldest are dropped. */
  memoryMax?: number;
}

export class ResponseCache {
  readonly #dir: string;
  readonly #enabled: boolean;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #memoryMax: number;
  readonly #memory = new Map<string, CacheEntry>();

  constructor(options: ResponseCacheOptions) {
    this.#dir = options.dir;
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

    const entry = await this.#readDisk(key);
    if (entry === undefined) return { state: 'miss' };

    this.#rememberInMemory(key, entry);
    return this.#classify(entry);
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    if (!this.#enabled) return;
    this.#rememberInMemory(key, entry);
    await this.#writeDisk(key, entry);
  }

  /** Marks an entry fresh again after a 304, without rewriting the body. */
  async refresh(key: string, entry: CacheEntry): Promise<void> {
    await this.set(key, { ...entry, storedAt: this.#clock.now() });
  }

  async clear(): Promise<void> {
    this.#memory.clear();
    await rm(this.#dir, { recursive: true, force: true });
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

  /** Two-character shard, so a large cache does not put 50k files in one directory. */
  #path(key: string): string {
    return join(this.#dir, key.slice(0, 2), `${key}.json`);
  }

  async #readDisk(key: string): Promise<CacheEntry | undefined> {
    try {
      const raw = await readFile(this.#path(key), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isCacheEntry(parsed)) {
        this.#logger.debug('cache entry ignored: unexpected shape', { key });
        return undefined;
      }
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        // A corrupt or unreadable cache file must never fail a request.
        this.#logger.debug('cache read failed', { key, code });
      }
      return undefined;
    }
  }

  async #writeDisk(key: string, entry: CacheEntry): Promise<void> {
    const path = this.#path(key);
    try {
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename so a crash mid-write cannot leave a truncated file
      // that later parses as valid JSON.
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(entry), 'utf8');
      const { rename } = await import('node:fs/promises');
      await rename(temp, path);
    } catch (error) {
      this.#logger.debug('cache write failed', { key, error });
    }
  }
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['storedAt'] === 'number' &&
    typeof candidate['ttlMs'] === 'number' &&
    'body' in candidate
  );
}
