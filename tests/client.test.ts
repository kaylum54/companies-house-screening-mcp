import { describe, expect, it } from 'vitest';

import { FakeClock } from '../src/clock.js';
import { CompaniesHouseError } from '../src/errors.js';
import { ResponseCache } from '../src/http/cache.js';
import { CompaniesHouseClient } from '../src/http/client.js';
import { RateLimiter } from '../src/http/rate-limiter.js';
import { FileCacheStore } from '../src/node/file-cache-store.js';
import { fakeFetchAlways, fakeFetchSequence, timeoutError } from './helpers/fake-fetch.js';
import { fixedRandom, loadFixture, testConfig, withTempDir } from './helpers/support.js';

const PROFILE = loadFixture('company/profile-active.json');

interface BuildOptions {
  fetchImpl: typeof fetch;
  cacheDir?: string;
  cacheEnabled?: boolean;
  maxRetries?: number;
  clock?: FakeClock;
}

function build(options: BuildOptions) {
  const clock = options.clock ?? new FakeClock(1_700_000_000_000);
  const config = testConfig({
    cacheEnabled: options.cacheEnabled ?? false,
    ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries })
  });

  const cache = new ResponseCache({
    store: new FileCacheStore({ dir: config.cacheDir ?? '/tmp/unused' }),
    enabled: config.cacheEnabled,
    clock
  });

  const client = new CompaniesHouseClient({
    config,
    clock,
    cache,
    limiter: new RateLimiter({
      limit: config.rateLimit,
      windowMs: config.rateWindowMs,
      safetyMargin: config.rateSafetyMargin,
      clock,
      jitterMs: 0,
      random: fixedRandom(0)
    }),
    fetchImpl: options.fetchImpl,
    random: fixedRandom(0)
  });

  return { client, clock, config };
}

describe('CompaniesHouseClient — request shape', () => {
  it('authenticates with the API key as the basic-auth username and a blank password', async () => {
    // Companies House ignores the password entirely, but the trailing colon is
    // still required or the header does not parse as basic auth.
    const fake = fakeFetchAlways({ body: PROFILE });
    const { client } = build({ fetchImpl: fake.fetch });

    await client.get({ path: '/company/00000006' });

    const expected = `Basic ${Buffer.from('test-key:').toString('base64')}`;
    expect(fake.calls[0]?.headers['authorization']).toBe(expected);
  });

  it('never puts the API key in the URL', async () => {
    const fake = fakeFetchAlways({ body: PROFILE });
    const { client } = build({ fetchImpl: fake.fetch });

    await client.get({ path: '/company/00000006' });
    expect(fake.calls[0]?.url).not.toContain('test-key');
  });

  it('sends a JSON accept header and an identifiable user agent', async () => {
    const fake = fakeFetchAlways({ body: PROFILE });
    const { client } = build({ fetchImpl: fake.fetch });

    await client.get({ path: '/company/00000006' });
    expect(fake.calls[0]?.headers['accept']).toBe('application/json');
    expect(fake.calls[0]?.headers['user-agent']).toBe('companies-house-screening-mcp-tests');
  });

  it('builds URLs against the configured base', async () => {
    const fake = fakeFetchAlways({ body: PROFILE });
    const { client } = build({ fetchImpl: fake.fetch });

    await client.get({ path: '/company/00000006/officers' });
    expect(fake.calls[0]?.url).toBe(
      'https://api.example-companies-house.test/company/00000006/officers'
    );
  });

  it('sorts query parameters so callers share a cache entry', async () => {
    const fake = fakeFetchAlways({ body: PROFILE });
    const { client } = build({ fetchImpl: fake.fetch });

    await client.get({ path: '/search/companies', query: { q: 'fixture', items_per_page: 20 } });
    expect(fake.calls[0]?.url).toContain('items_per_page=20&q=fixture');
  });

  it('drops undefined query parameters rather than sending the string "undefined"', async () => {
    const fake = fakeFetchAlways({ body: PROFILE });
    const { client } = build({ fetchImpl: fake.fetch });

    await client.get({ path: '/search/companies', query: { q: 'fixture', start_index: undefined } });
    expect(fake.calls[0]?.url).not.toContain('start_index');
  });

  it('returns the parsed body with request metadata', async () => {
    const fake = fakeFetchAlways({ body: PROFILE });
    const { client } = build({ fetchImpl: fake.fetch });

    const response = await client.get({ path: '/company/00000006' });
    expect(response.data).toEqual(PROFILE);
    expect(response.meta.cached).toBe(false);
    expect(response.meta.attempts).toBe(1);
    expect(response.meta.rateLimit.remaining).toBe(569);
  });
});

describe('CompaniesHouseClient — caching', () => {
  it('serves a repeat request from cache without touching the network', async () => {
    await withTempDir(async (dir) => {
      const fake = fakeFetchAlways({ body: PROFILE });
      const { client } = build({ fetchImpl: fake.fetch, cacheDir: dir, cacheEnabled: true });

      await client.get({ path: '/company/00000006', resource: 'company-profile' });
      const second = await client.get({ path: '/company/00000006', resource: 'company-profile' });

      expect(fake.calls).toHaveLength(1);
      expect(second.meta.cached).toBe(true);
      expect(second.data).toEqual(PROFILE);
    });
  });

  it('does not consume rate-limit budget for a cache hit', async () => {
    await withTempDir(async (dir) => {
      const fake = fakeFetchAlways({ body: PROFILE });
      const { client } = build({ fetchImpl: fake.fetch, cacheDir: dir, cacheEnabled: true });

      await client.get({ path: '/company/00000006', resource: 'company-profile' });
      const after = client.rateLimit.remaining;
      await client.get({ path: '/company/00000006', resource: 'company-profile' });

      expect(client.rateLimit.remaining).toBe(after);
    });
  });

  it('bypasses the cache on request but still refreshes it', async () => {
    await withTempDir(async (dir) => {
      const fake = fakeFetchAlways({ body: PROFILE });
      const { client } = build({ fetchImpl: fake.fetch, cacheDir: dir, cacheEnabled: true });

      await client.get({ path: '/company/00000006', resource: 'company-profile' });
      const forced = await client.get({
        path: '/company/00000006',
        resource: 'company-profile',
        bypassCache: true
      });

      expect(fake.calls).toHaveLength(2);
      expect(forced.meta.cached).toBe(false);
    });
  });

  it('revalidates a stale entry with If-None-Match and accepts a 304', async () => {
    await withTempDir(async (dir) => {
      const clock = new FakeClock(1_700_000_000_000);
      const fake = fakeFetchSequence([
        { body: PROFILE, headers: { etag: 'W/"v1"' } },
        { status: 304 }
      ]);
      const { client } = build({ fetchImpl: fake.fetch, cacheDir: dir, cacheEnabled: true, clock });

      await client.get({ path: '/company/00000006', ttlMs: 1000 });
      clock.advance(2000);
      const second = await client.get({ path: '/company/00000006', ttlMs: 1000 });

      expect(fake.calls[1]?.headers['if-none-match']).toBe('W/"v1"');
      expect(second.meta.revalidated).toBe(true);
      expect(second.data).toEqual(PROFILE);
    });
  });

  it('does not send If-None-Match when the API supplied no HTTP ETag', async () => {
    // The `etag` field inside the JSON body is a resource-version marker, not
    // an HTTP validator. Treating it as one would produce wrong results
    // silently, which is the worst kind.
    await withTempDir(async (dir) => {
      const clock = new FakeClock(1_700_000_000_000);
      const fake = fakeFetchSequence([{ body: PROFILE }, { body: PROFILE }]);
      const { client } = build({ fetchImpl: fake.fetch, cacheDir: dir, cacheEnabled: true, clock });

      await client.get({ path: '/company/00000006', ttlMs: 1000 });
      clock.advance(2000);
      await client.get({ path: '/company/00000006', ttlMs: 1000 });

      expect(fake.calls[1]?.headers['if-none-match']).toBeUndefined();
    });
  });

  it('serves an expired entry when the upstream is failing', async () => {
    await withTempDir(async (dir) => {
      const clock = new FakeClock(1_700_000_000_000);
      const fake = fakeFetchSequence([
        { body: PROFILE },
        { status: 503 },
        { status: 503 },
        { status: 503 },
        { status: 503 }
      ]);
      const { client } = build({
        fetchImpl: fake.fetch,
        cacheDir: dir,
        cacheEnabled: true,
        clock
      });

      await client.get({ path: '/company/00000006', ttlMs: 1000 });
      clock.advance(5000);
      const degraded = await client.get({ path: '/company/00000006', ttlMs: 1000 });

      expect(degraded.data).toEqual(PROFILE);
      expect(degraded.meta.stale).toBe(true);
      expect(degraded.meta.cached).toBe(true);
    });
  });

  it('does not serve stale data when the company genuinely does not exist', async () => {
    // A 404 is a real answer, not an outage. Papering over it with a cached
    // copy would be worse than failing.
    await withTempDir(async (dir) => {
      const clock = new FakeClock(1_700_000_000_000);
      const fake = fakeFetchSequence([{ body: PROFILE }, { status: 404 }]);
      const { client } = build({ fetchImpl: fake.fetch, cacheDir: dir, cacheEnabled: true, clock });

      await client.get({ path: '/company/00000006', ttlMs: 1000 });
      clock.advance(5000);

      await expect(client.get({ path: '/company/00000006', ttlMs: 1000 })).rejects.toThrow(
        CompaniesHouseError
      );
    });
  });
});

describe('CompaniesHouseClient — failure handling', () => {
  it('retries a 429 and succeeds', async () => {
    const fake = fakeFetchSequence([
      { status: 429, headers: { 'retry-after': '1' } },
      { body: PROFILE }
    ]);
    const { client } = build({ fetchImpl: fake.fetch });

    const response = await client.get({ path: '/company/00000006' });
    expect(response.data).toEqual(PROFILE);
    expect(response.meta.attempts).toBe(2);
  });

  it('retries a 503 and succeeds', async () => {
    const fake = fakeFetchSequence([{ status: 503 }, { body: PROFILE }]);
    const { client } = build({ fetchImpl: fake.fetch });

    const response = await client.get({ path: '/company/00000006' });
    expect(response.meta.attempts).toBe(2);
  });

  it('gives up after the configured number of retries', async () => {
    const fake = fakeFetchAlways({ status: 503 });
    const { client } = build({ fetchImpl: fake.fetch, maxRetries: 2 });

    await expect(client.get({ path: '/company/00000006' })).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE'
    });
    expect(fake.calls).toHaveLength(3);
  });

  it('does not retry a 404', async () => {
    const fake = fakeFetchAlways({ status: 404 });
    const { client } = build({ fetchImpl: fake.fetch });

    await expect(
      client.get({ path: '/company/99999999', label: 'company', identifier: '99999999' })
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(fake.calls).toHaveLength(1);
  });

  it('does not retry a bad API key', async () => {
    const fake = fakeFetchAlways({ status: 401 });
    const { client } = build({ fetchImpl: fake.fetch });

    await expect(client.get({ path: '/company/00000006' })).rejects.toMatchObject({
      code: 'AUTH_INVALID'
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('classifies a timeout distinctly from a network failure', async () => {
    const fake = fakeFetchAlways({ throws: timeoutError() });
    const { client } = build({ fetchImpl: fake.fetch, maxRetries: 0 });

    await expect(client.get({ path: '/company/00000006' })).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT'
    });
  });

  it('classifies a connection failure as a network error and retries it', async () => {
    const fake = fakeFetchAlways({ throws: new TypeError('fetch failed') });
    const { client } = build({ fetchImpl: fake.fetch, maxRetries: 1 });

    await expect(client.get({ path: '/company/00000006' })).rejects.toMatchObject({
      code: 'NETWORK_ERROR'
    });
    expect(fake.calls).toHaveLength(2);
  });

  it('reports an HTML error page as a malformed response, not a crash', async () => {
    const fake = fakeFetchAlways({ text: '<html><body>Gateway Timeout</body></html>' });
    const { client } = build({ fetchImpl: fake.fetch });

    await expect(client.get({ path: '/company/00000006' })).rejects.toMatchObject({
      code: 'UPSTREAM_MALFORMED'
    });
  });

  it('treats an empty body as an empty object rather than failing to parse', async () => {
    const fake = fakeFetchAlways({ text: '' });
    const { client } = build({ fetchImpl: fake.fetch });

    const response = await client.get({ path: '/company/00000006' });
    expect(response.data).toEqual({});
  });

  it('holds back traffic after a 429 that carries Retry-After', async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const fake = fakeFetchSequence([
      { status: 429, headers: { 'retry-after': '30' } },
      { body: PROFILE }
    ]);
    const { client } = build({ fetchImpl: fake.fetch, clock });

    const before = clock.now();
    await client.get({ path: '/company/00000006' });
    expect(clock.now() - before).toBeGreaterThanOrEqual(30_000);
  });
});

describe('CompaniesHouseClient — in-flight coalescing', () => {
  it('makes one upstream call when the same URL is asked for concurrently', async () => {
    // The cache only helps once an answer exists. A screen_companies fan-out
    // issues its requests together, so several callers wanting the same
    // company all miss at once and would each spend a slot of the budget the
    // shared cache exists to conserve.
    const fake = fakeFetchAlways({ body: PROFILE });
    const { client } = build({ fetchImpl: fake.fetch });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => client.get({ path: '/company/04138203', label: 'company' }))
    );

    expect(fake.calls).toHaveLength(1);
    // Every follower got the leader's answer, and each is marked as having
    // made no upstream call — which is exactly what happened to it.
    expect(responses.filter((response) => response.meta.cached)).toHaveLength(9);
    for (const response of responses) {
      expect(response.data).toEqual(responses[0]?.data);
    }
  });

  it('spends one slot of budget for a coalesced burst, not ten', async () => {
    const fake = fakeFetchAlways({ body: PROFILE });
    const { client } = build({ fetchImpl: fake.fetch });
    const before = (await client.budget()).remaining;

    await Promise.all(
      Array.from({ length: 10 }, () => client.get({ path: '/company/04138203', label: 'company' }))
    );

    expect((await client.budget()).remaining).toBe(before - 1);
  });

  it('does not coalesce requests for different URLs', async () => {
    const fake = fakeFetchAlways({ body: PROFILE });
    const { client } = build({ fetchImpl: fake.fetch });

    await Promise.all([
      client.get({ path: '/company/04138203', label: 'company' }),
      client.get({ path: '/company/00000006', label: 'company' })
    ]);

    expect(fake.calls).toHaveLength(2);
  });

  it('does not leave a failed request behind for later callers to adopt', async () => {
    // A rejected promise left in the map would be inherited by every
    // subsequent caller, turning one upstream blip into a permanent outage
    // for that URL.
    const fake = fakeFetchSequence([
      { throws: timeoutError() },
      { throws: timeoutError() },
      { throws: timeoutError() },
      { throws: timeoutError() },
      { body: PROFILE }
    ]);
    const { client } = build({ fetchImpl: fake.fetch, maxRetries: 3 });

    await expect(client.get({ path: '/company/04138203', label: 'company' })).rejects.toBeDefined();
    await expect(
      client.get({ path: '/company/04138203', label: 'company' })
    ).resolves.toBeDefined();
  });
});
