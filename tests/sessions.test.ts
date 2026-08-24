import { describe, expect, it } from 'vitest';

import { FakeClock } from '../src/clock.js';
import { MemoryBudgetStore } from '../src/http/budget-store.js';
import { ResponseCache } from '../src/http/cache.js';
import { CompaniesHouseClient } from '../src/http/client.js';
import { RateLimiter } from '../src/http/rate-limiter.js';
import { silentLogger } from '../src/telemetry/logger.js';
import type { ClientIdentity } from '../src/transport/identity.js';
import { fingerprint, NoAuthProvider } from '../src/transport/identity.js';
import {
  createPooledBudgetStore,
  createSession,
  defaultClientReservation,
  type SessionFactoryOptions
} from '../src/transport/sessions.js';
import { fakeFetchAlways } from './helpers/fake-fetch.js';
import { loadFixture, testConfig } from './helpers/support.js';

/**
 * What a session shares and what it does not.
 *
 * These are the load-bearing claims of the hosted design: one cache for
 * everybody because the register is public, one budget per *key* because
 * Companies House meters per key. Getting either backwards is expensive —
 * a partitioned cache multiplies upstream cost for nothing, and a shared
 * budget across keys hands one caller's allowance to another.
 */

const NOW = Date.parse('2026-08-20T00:00:00.000Z');
const profile = loadFixture('company/profile-active.json');

function factory(overrides: Partial<SessionFactoryOptions> = {}): {
  options: SessionFactoryOptions;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const config = testConfig({ cacheEnabled: true, rateLimit: 100, rateSafetyMargin: 1 });
  const clock = new FakeClock(NOW);
  const fake = fakeFetchAlways({ body: profile });
  const cache = new ResponseCache({ enabled: true, clock });

  const pooledClient = new CompaniesHouseClient({
    config,
    logger: silentLogger,
    clock,
    cache,
    fetchImpl: fake.fetch,
    limiter: new RateLimiter({ clock, store: createPooledBudgetStore(config) })
  });

  return {
    calls: fake.calls,
    options: {
      config,
      logger: silentLogger,
      clock,
      version: 'test',
      cache,
      pooledClient,
      createBudgetStore: () =>
        new MemoryBudgetStore({ limit: config.rateLimit, windowMs: config.rateWindowMs, safetyMargin: 1 }),
      fetchImpl: fake.fetch,
      ...overrides
    }
  };
}

const pooled = (id: string): ClientIdentity => ({ clientId: id, ownsBudget: false });
const owned = (key: string): ClientIdentity => ({
  clientId: `key:${fingerprint(key)}`,
  apiKey: key,
  ownsBudget: true
});

describe('sessions — the shared budget', () => {
  it('counts two pooled sessions against one window', async () => {
    // The bug this whole design exists to fix. Two callers on the same key
    // must not each believe they own the full allowance.
    const { options } = factory();
    const a = createSession(options, pooled('caller-a'));
    const b = createSession(options, pooled('caller-b'));

    const before = (await a.client.budget()).remaining;
    for (let i = 0; i < 10; i += 1) {
      await b.client.get({ path: `/company/1000${i}`, label: 'company' });
    }
    const after = (await a.client.budget()).remaining;

    // What one session spends, the other can see. The exact figure is fair
    // sharing's business and is pinned down in budget.test.ts; the claim here
    // is only that the two sessions are looking at the same window at all.
    expect(after).toBeLessThan(before);
  });

  it('gives a caller with their own key a window of their own', async () => {
    const { options } = factory();
    const shared = createSession(options, pooled('caller-a'));
    const private_ = createSession(options, owned('their-own-key'));

    const pooledBefore = (await shared.client.budget()).remaining;
    const privateBefore = (await private_.client.budget()).remaining;

    for (let i = 0; i < 20; i += 1) {
      await shared.client.get({ path: `/company/2000${i}`, label: 'company' });
    }

    // The pooled window moved. The private one is untouched — that is the
    // whole promise of bringing your own key.
    expect((await shared.client.budget()).remaining).toBeLessThan(pooledBefore);
    expect((await private_.client.budget()).remaining).toBe(privateBefore);
  });

  it('does not let pooled traffic exhaust a private budget, or the reverse', async () => {
    const { options } = factory();
    const shared = createSession(options, pooled('caller-a'));
    const private_ = createSession(options, owned('their-own-key'));

    for (let i = 0; i < 30; i += 1) {
      await private_.client.get({ path: `/company/3000${i}`, label: 'company' });
    }

    // Thirty requests on a private key must cost the pool nothing at all.
    expect((await shared.client.budget()).remaining).toBe(
      (await createSession(options, pooled('caller-c')).client.budget()).remaining
    );
  });

  it('sends each session upstream with the key it is supposed to be spending', async () => {
    const { options, calls } = factory();
    const shared = createSession(options, pooled('caller-a'));
    const private_ = createSession(options, owned('their-own-key'));

    await shared.client.get({ path: '/company/20000001', label: 'company' });
    const pooledAuth = calls.at(-1)?.headers['authorization'];

    await private_.client.get({ path: '/company/20000002', label: 'company' });
    const privateAuth = calls.at(-1)?.headers['authorization'];

    expect(pooledAuth).toBe(`Basic ${Buffer.from('test-key:').toString('base64')}`);
    expect(privateAuth).toBe(`Basic ${Buffer.from('their-own-key:').toString('base64')}`);
  });
});

describe('sessions — the shared cache', () => {
  it('serves one session from a warm cache another session filled', async () => {
    // The economic argument for hosting: the tenth person to screen a supplier
    // should not pay for the same request the first person already made.
    const { options, calls } = factory();
    const first = createSession(options, pooled('caller-a'));
    const second = createSession(options, pooled('caller-b'));

    await first.client.get({ path: '/company/04138203', label: 'company' });
    expect(calls).toHaveLength(1);

    const response = await second.client.get({ path: '/company/04138203', label: 'company' });
    expect(calls).toHaveLength(1);
    expect(response.meta.cached).toBe(true);
  });

  it('shares the cache across keys, because the register is public either way', async () => {
    const { options, calls } = factory();
    const shared = createSession(options, pooled('caller-a'));
    const private_ = createSession(options, owned('their-own-key'));

    await shared.client.get({ path: '/company/04138203', label: 'company' });
    const response = await private_.client.get({ path: '/company/04138203', label: 'company' });

    expect(calls).toHaveLength(1);
    expect(response.meta.cached).toBe(true);
  });
});

describe('defaultClientReservation', () => {
  it('gives each caller an eighth of the effective window by default', () => {
    const config = testConfig({ rateLimit: 600, rateSafetyMargin: 0.95 });
    expect(defaultClientReservation(config)).toBe(71);
  });

  it('honours an explicit setting, because an operator knows their own traffic', () => {
    const config = testConfig({ rateLimit: 600, clientReservation: 200 });
    expect(defaultClientReservation(config)).toBe(200);
  });
});

describe('NoAuthProvider', () => {
  const provider = new NoAuthProvider();

  it('admits a caller with no credentials at all', async () => {
    const result = await provider.authenticate({ header: () => null, remoteAddress: '203.0.113.7' });
    expect(result.ok).toBe(true);
  });

  it('separates callers by address so fair sharing has something to be fair between', async () => {
    const one = await provider.authenticate({ header: () => null, remoteAddress: '203.0.113.7' });
    const two = await provider.authenticate({ header: () => null, remoteAddress: '198.51.100.4' });

    expect(one.ok && two.ok && one.identity.clientId).not.toBe(two.ok && two.identity.clientId);
  });

  it('never puts a raw address in the identity', async () => {
    const result = await provider.authenticate({ header: () => null, remoteAddress: '203.0.113.7' });
    expect(result.ok && result.identity.clientId).not.toContain('203.0.113.7');
  });

  it('treats a supplied key as the principal and marks the budget as theirs', async () => {
    const result = await provider.authenticate({
      header: (name) => (name === 'x-companies-house-api-key' ? 'their-key' : null)
    });

    expect(result.ok && result.identity.ownsBudget).toBe(true);
    expect(result.ok && result.identity.apiKey).toBe('their-key');
    expect(result.ok && result.identity.clientId).not.toContain('their-key');
  });

  it.each([
    ['a newline, which is how header injection starts', 'key\nX-Evil: 1'],
    ['a space', 'two words'],
    ['an empty value', '   '],
    ['something absurdly long', 'x'.repeat(300)]
  ])('ignores a malformed key: %s', async (_label, value) => {
    const result = await provider.authenticate({
      header: (name) => (name === 'x-companies-house-api-key' ? value : null),
      remoteAddress: '203.0.113.7'
    });

    // Dropped into the shared pool rather than passed on to an auth header.
    expect(result.ok && result.identity.apiKey).toBeUndefined();
    expect(result.ok && result.identity.ownsBudget).toBe(false);
  });

  it('can be told not to accept caller keys at all', async () => {
    const strict = new NoAuthProvider({ allowClientKeys: false });
    const result = await strict.authenticate({
      header: () => 'a-real-looking-key',
      remoteAddress: '203.0.113.7'
    });

    expect(result.ok && result.identity.apiKey).toBeUndefined();
  });
});
