import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FakeClock } from '../src/clock.js';
import { DEFAULT_TTLS, ResponseCache } from '../src/http/cache.js';
import { FileCacheStore } from '../src/node/file-cache-store.js';
import { withTempDir } from './helpers/support.js';

const entry = (body: unknown, storedAt: number, ttlMs = 1000) => ({ body, storedAt, ttlMs });

describe('ResponseCache', () => {
  it('reports a miss for an unknown key', async () => {
    await withTempDir(async (dir) => {
      const cache = new ResponseCache({ store: new FileCacheStore({ dir }), clock: new FakeClock(0) });
      expect((await cache.get('nope')).state).toBe('miss');
    });
  });

  it('serves a fresh entry inside its TTL', async () => {
    await withTempDir(async (dir) => {
      const clock = new FakeClock(0);
      const cache = new ResponseCache({ store: new FileCacheStore({ dir }), clock });
      await cache.set('k', entry({ hello: 'world' }, 0, 1000));

      clock.advance(999);
      const lookup = await cache.get('k');
      expect(lookup.state).toBe('fresh');
      expect(lookup.state === 'fresh' && lookup.entry.body).toEqual({ hello: 'world' });
    });
  });

  it('marks an entry stale once the TTL passes rather than discarding it', async () => {
    // Stale entries still have value: they can be revalidated with an ETag,
    // and they are what gets served if the upstream is down.
    await withTempDir(async (dir) => {
      const clock = new FakeClock(0);
      const cache = new ResponseCache({ store: new FileCacheStore({ dir }), clock });
      await cache.set('k', entry({ hello: 'world' }, 0, 1000));

      clock.advance(1001);
      const lookup = await cache.get('k');
      expect(lookup.state).toBe('stale');
      expect(lookup.state === 'stale' && lookup.entry.body).toEqual({ hello: 'world' });
    });
  });

  it('survives a process restart by reading from disk', async () => {
    await withTempDir(async (dir) => {
      const clock = new FakeClock(0);
      const first = new ResponseCache({ store: new FileCacheStore({ dir }), clock });
      await first.set('k', entry({ persisted: true }, 0, 10_000));

      const second = new ResponseCache({ store: new FileCacheStore({ dir }), clock });
      const lookup = await second.get('k');
      expect(lookup.state).toBe('fresh');
      expect(lookup.state === 'fresh' && lookup.entry.body).toEqual({ persisted: true });
    });
  });

  it('refresh resets the age without rewriting the body', async () => {
    await withTempDir(async (dir) => {
      const clock = new FakeClock(0);
      const cache = new ResponseCache({ store: new FileCacheStore({ dir }), clock });
      const original = entry({ v: 1 }, 0, 1000);
      await cache.set('k', original);

      clock.advance(2000);
      expect((await cache.get('k')).state).toBe('stale');

      await cache.refresh('k', original);
      const lookup = await cache.get('k');
      expect(lookup.state).toBe('fresh');
      expect(lookup.state === 'fresh' && lookup.entry.body).toEqual({ v: 1 });
    });
  });

  it('does nothing at all when disabled', async () => {
    await withTempDir(async (dir) => {
      const cache = new ResponseCache({ store: new FileCacheStore({ dir }), enabled: false, clock: new FakeClock(0) });
      await cache.set('k', entry({ v: 1 }, 0));
      expect((await cache.get('k')).state).toBe('miss');
      await expect(readdir(dir)).resolves.toEqual([]);
    });
  });

  it('evicts the oldest entries when memory fills', async () => {
    await withTempDir(async (dir) => {
      const cache = new ResponseCache({ store: new FileCacheStore({ dir }), clock: new FakeClock(0), memoryMax: 2 });
      await cache.set('a', entry({ n: 1 }, 0));
      await cache.set('b', entry({ n: 2 }, 0));
      await cache.set('c', entry({ n: 3 }, 0));
      expect(cache.size).toBe(2);
    });
  });

  it('ignores a corrupt cache file instead of failing the request', async () => {
    await withTempDir(async (dir) => {
      const cache = new ResponseCache({ store: new FileCacheStore({ dir }), clock: new FakeClock(0) });
      const key = ResponseCache.key('GET', 'https://example.test/thing');
      await mkdir(join(dir, key.slice(0, 2)), { recursive: true });
      await writeFile(join(dir, key.slice(0, 2), `${key}.json`), '{ not json', 'utf8');

      expect((await cache.get(key)).state).toBe('miss');
    });
  });

  it('ignores a cache file whose shape is wrong', async () => {
    await withTempDir(async (dir) => {
      const cache = new ResponseCache({ store: new FileCacheStore({ dir }), clock: new FakeClock(0) });
      const key = ResponseCache.key('GET', 'https://example.test/other');
      await mkdir(join(dir, key.slice(0, 2)), { recursive: true });
      await writeFile(join(dir, key.slice(0, 2), `${key}.json`), '{"unexpected":true}', 'utf8');

      expect((await cache.get(key)).state).toBe('miss');
    });
  });

  it('keys on method and url together', () => {
    const a = ResponseCache.key('GET', 'https://example.test/a');
    const b = ResponseCache.key('GET', 'https://example.test/b');
    expect(a).not.toBe(b);
    expect(a).toBe(ResponseCache.key('get', 'https://example.test/a'));
  });

  it('clears everything', async () => {
    await withTempDir(async (dir) => {
      const cache = new ResponseCache({ store: new FileCacheStore({ dir }), clock: new FakeClock(0) });
      await cache.set('k', entry({ v: 1 }, 0));
      await cache.clear();
      expect(cache.size).toBe(0);
      expect((await cache.get('k')).state).toBe('miss');
    });
  });
});

describe('DEFAULT_TTLS', () => {
  it('gives filing history the shortest life of the company sections', () => {
    // Filing history is the section that changes when anything happens, so it
    // is the one worth re-fetching most often.
    expect(DEFAULT_TTLS['filing-history']).toBeLessThan(DEFAULT_TTLS['company-profile']);
    expect(DEFAULT_TTLS['filing-history']).toBeLessThan(DEFAULT_TTLS.charges);
  });

  it('covers every resource kind', () => {
    for (const value of Object.values(DEFAULT_TTLS)) {
      expect(value).toBeGreaterThan(0);
    }
  });
});
