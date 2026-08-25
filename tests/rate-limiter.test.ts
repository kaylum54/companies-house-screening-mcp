import { describe, expect, it } from 'vitest';

import { FakeClock } from '../src/clock.js';
import { RateLimiter } from '../src/http/rate-limiter.js';
import { fixedRandom } from './helpers/support.js';

const build = (overrides: Partial<ConstructorParameters<typeof RateLimiter>[0]> = {}) => {
  const clock = new FakeClock(1_000_000);
  const limiter = new RateLimiter({
    limit: 10,
    windowMs: 60_000,
    safetyMargin: 1,
    clock,
    jitterMs: 0,
    random: fixedRandom(0),
    ...overrides
  });
  return { clock, limiter };
};

describe('RateLimiter', () => {
  it('applies the safety margin to the documented limit', () => {
    // The budget belongs to the API key, not to this process. Running to
    // exactly 600 guarantees a 429 for whatever else shares the key.
    const { limiter } = build({ limit: 600, safetyMargin: 0.95 });
    expect(limiter.effectiveLimit).toBe(570);
  });

  it('allows a burst up to the effective limit without waiting', async () => {
    const { clock, limiter } = build();
    for (let i = 0; i < 10; i += 1) await limiter.acquire();
    expect(clock.sleeps).toHaveLength(0);
    expect((await limiter.snapshot()).remaining).toBe(0);
  });

  it('waits for the oldest request to leave the window once full', async () => {
    const { clock, limiter } = build();
    for (let i = 0; i < 10; i += 1) await limiter.acquire();

    const before = clock.now();
    await limiter.acquire();
    expect(clock.now() - before).toBeGreaterThanOrEqual(60_000);
  });

  it('recovers budget as the window slides', async () => {
    const { clock, limiter } = build();
    for (let i = 0; i < 10; i += 1) await limiter.acquire();
    expect((await limiter.snapshot()).remaining).toBe(0);

    clock.advance(60_001);
    expect((await limiter.snapshot()).remaining).toBe(10);
  });

  it('serialises concurrent acquisitions so the budget cannot be oversold', async () => {
    // Ten callers reading a budget of one, all deciding they may proceed, is
    // the failure this exists to prevent.
    const { limiter } = build({ limit: 3, safetyMargin: 1 });
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2].map(async (i) => {
        await limiter.acquire();
        order.push(i);
      })
    );

    expect(order).toHaveLength(3);
    expect((await limiter.snapshot()).remaining).toBe(0);
  });

  it('tightens the local budget when the server says it is lower', async () => {
    const { limiter } = build();
    await limiter.acquire();
    expect((await limiter.snapshot()).remaining).toBe(9);

    await limiter.applyServerHeaders(new Headers({ 'x-ratelimit-remain': '2' }));
    expect((await limiter.snapshot()).remaining).toBe(2);
  });

  it('reads the conventional header spelling too', async () => {
    const { limiter } = build();
    await limiter.applyServerHeaders(new Headers({ 'x-ratelimit-remaining': '4' }));
    expect((await limiter.snapshot()).remaining).toBe(4);
  });

  it('ignores a server hint once its reset time has passed', async () => {
    const { clock, limiter } = build();
    await limiter.applyServerHeaders(
      new Headers({
        'x-ratelimit-remain': '0',
        'x-ratelimit-reset': String(Math.floor((clock.now() + 30_000) / 1000))
      })
    );
    expect((await limiter.snapshot()).remaining).toBe(0);

    clock.advance(31_000);
    expect((await limiter.snapshot()).remaining).toBe(10);
  });

  it('expires a server hint that arrived without a reset time', async () => {
    // Otherwise `remain: 0` with no `reset` header deadlocks the process on
    // the strength of a field that is not even documented.
    const { clock, limiter } = build();
    await limiter.applyServerHeaders(new Headers({ 'x-ratelimit-remain': '0' }));
    expect((await limiter.snapshot()).remaining).toBe(0);

    clock.advance(60_001);
    expect((await limiter.snapshot()).remaining).toBe(10);
  });

  it('holds all traffic until a penalty expires', async () => {
    const { clock, limiter } = build();
    const resetAt = clock.now() + 45_000;
    await limiter.penalise(resetAt);

    expect((await limiter.snapshot()).resetInMs).toBe(45_000);
    await limiter.acquire();
    expect(clock.now()).toBeGreaterThanOrEqual(resetAt);
  });

  it('reports zero reset time while budget remains', async () => {
    const { limiter } = build();
    await limiter.acquire();
    expect((await limiter.snapshot()).resetInMs).toBe(0);
  });

  it('throws rather than spinning if the injected clock never advances', async () => {
    const frozen = { now: () => 1000, sleep: async () => {} };
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 60_000,
      safetyMargin: 1,
      clock: frozen,
      jitterMs: 0,
      random: fixedRandom(0)
    });

    await limiter.acquire();
    await expect(limiter.acquire()).rejects.toThrow(/not advancing/);
  });

  it('keeps serving after a rejected acquisition', async () => {
    // A failed acquire must not poison the serialisation chain for everyone
    // that queued behind it.
    const frozen = { now: () => 1000, sleep: async () => {} };
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 60_000,
      safetyMargin: 1,
      clock: frozen,
      jitterMs: 0
    });

    await limiter.acquire();
    await expect(limiter.acquire()).rejects.toThrow();
    await expect(limiter.acquire()).rejects.toThrow();
  });
});

describe('RateLimiter — exhausting the retry bound', () => {
  it('reports congestion as RATE_LIMITED rather than as a server bug', async () => {
    // The 64-attempt bound guards against a frozen clock, but it is reachable
    // with a healthy one: a caller held to its reservation while its own burst
    // ages out can be refused many times inside the wait window. Reporting
    // that as INTERNAL_ERROR would tell the caller their request is a bug in
    // the server and not retryable, when it is neither.
    const clock = new FakeClock(0);
    const limiter = new RateLimiter({
      clock,
      jitterMs: 0,
      random: () => 0,
      maxWaitMs: Number.MAX_SAFE_INTEGER,
      store: {
        acquire: async () => ({
          granted: false,
          remaining: 0,
          retryInMs: 1,
          limit: 10,
          boundBy: 'client' as const
        }),
        peek: async () => ({ granted: false, remaining: 0, retryInMs: 1, limit: 10 }),
        penalise: async () => undefined,
        observe: async () => undefined
      }
    });

    await expect(limiter.acquire('busy')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true
    });
  });
});

describe('RateLimiter — the wait ceiling', () => {
  it('waits for the window by default, as the stdio server always has', async () => {
    // Adding a ceiling for the hosted server must not have silently changed
    // what a local install does. stdio has one caller, no connection to hold
    // open, and waiting out the window is the behaviour that shipped.
    const clock = new FakeClock(0);
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 300_000,
      safetyMargin: 1,
      clock,
      jitterMs: 0,
      random: () => 0
    });

    await limiter.acquire();

    // The second acquisition waits rather than throwing at t=0.
    const pending = limiter.acquire();
    await expect(pending).resolves.toBeDefined();
    expect(clock.now()).toBeGreaterThanOrEqual(300_000);
  });

  it('gives up once a ceiling is set, so a server does not hang a connection', async () => {
    const clock = new FakeClock(0);
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 300_000,
      safetyMargin: 1,
      clock,
      jitterMs: 0,
      random: () => 0,
      maxWaitMs: 1_000
    });

    await limiter.acquire();
    await expect(limiter.acquire()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
