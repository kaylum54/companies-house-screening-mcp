import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CacheEntry, CacheStore } from '../http/cache-store.js';
import { isCacheEntry } from '../http/cache-store.js';
import type { Logger } from '../telemetry/logger.js';
import { silentLogger } from '../telemetry/logger.js';

/**
 * Filesystem-backed cache, for the stdio server and any Node deployment with
 * a writable disk.
 *
 * This is the behaviour that used to live inside `ResponseCache`. It moved out
 * so that the portable core carries no `node:fs` import — see `cache-store.ts`
 * for why that matters.
 *
 * Restarting is the normal case, not the exceptional one: a host relaunches
 * the stdio server every time it reconnects. Throwing away a day of cached
 * register data on every reconnect is what this file prevents.
 */

export interface FileCacheStoreOptions {
  dir: string;
  logger?: Logger;
}

export class FileCacheStore implements CacheStore {
  readonly #dir: string;
  readonly #logger: Logger;

  constructor(options: FileCacheStoreOptions) {
    this.#dir = options.dir;
    this.#logger = options.logger ?? silentLogger;
  }

  /** Two-character shard, so a large cache does not put 50k files in one directory. */
  #path(key: string): string {
    return join(this.#dir, key.slice(0, 2), `${key}.json`);
  }

  async read(key: string): Promise<CacheEntry | undefined> {
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

  async write(key: string, entry: CacheEntry): Promise<void> {
    const path = this.#path(key);
    try {
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename so a crash mid-write cannot leave a truncated file
      // that later parses as valid JSON.
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(entry), 'utf8');
      await rename(temp, path);
    } catch (error) {
      this.#logger.debug('cache write failed', { key, error });
    }
  }

  async clear(): Promise<void> {
    await rm(this.#dir, { recursive: true, force: true });
  }
}
