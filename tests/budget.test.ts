import { describe, expect, it } from 'vitest';

import type { SlidingWindowBudgetOptions } from '../src/http/budget.js';
import { SlidingWindowBudget } from '../src/http/budget.js';
import { MemoryBudgetStore } from '../src/http/budget-store.js';

/**
 * The claims this file has to establish, because they are the reason the
 * budget was rewritten at all:
 *
 *  1. The global window is honoured no matter how many clients there are.
 *  2. A heavy client cannot starve a light one.
 *  3. A lone client is not made slower by machinery meant for a crowd.
 *  4. `peek` and `acquire` agree, or `screen_companies` lies about its table.
 */

const WINDOW = 300_000;

/** limit 100, margin 1.0 → effective 100. Round numbers make the maths readable. */
const build = (over: SlidingWindowBudgetOptions = {}) =>
  new SlidingWindowBudget({
    limit: 100,
    windowMs: WINDOW,
    safetyMargin: 1,
    ...over
  });

describe('SlidingWindowBudget — the global window', () => {
  it('grants up to the effective limit and no further', () => {
    const budget = build();
    for (let i = 0; i < 100; i += 1) {
      expect(budget.acquire('a', 1000).granted).toBe(true);
    }
    const refused = budget.acquire('a', 1000);
    expect(refused.granted).toBe(false);
    expect(refused.boundBy).toBe('global');
  });

  it('applies the safety margin, because the key is shared with things we cannot see', () => {
    const budget = new SlidingWindowBudget({ limit: 600, windowMs: WINDOW, safetyMargin: 0.95 });
    expect(budget.effectiveLimit).toBe(570);
  });

  it('counts every client against one window rather than one window each', () => {
    // This is the bug the rewrite exists to fix. Five sessions on one key had
    // five independent limiters and believed they collectively owned 5x600.
    const budget = build();
    for (let i = 0; i < 100; i += 1) {
      expect(budget.acquire(`client-${i % 5}`, 1000).granted).toBe(true);
    }
    expect(budget.acquire('client-0', 1000).granted).toBe(false);
    expect(budget.acquire('client-9', 1000).granted).toBe(false);
  });

  it('frees slots as they age out of the window', () => {
    const budget = build();
    for (let i = 0; i < 100; i += 1) budget.acquire('a', 1000);
    expect(budget.acquire('a', 1000).granted).toBe(false);

    expect(budget.acquire('a', 1000 + WINDOW + 1).granted).toBe(true);
  });
});

describe('SlidingWindowBudget — fair share', () => {
  // reservation 10, one newcomer's worth held back. With N other clients
  // active, a client may burst until 100 - (N + 1) * 10 of the window is gone.
  const shared = () => build({ clientReservation: 10 });

  it('leaves a lone client almost the whole budget, holding back one share', () => {
    // Work-conserving on purpose: the reservation is a floor under everyone
    // else, not a ceiling on you. A single user on an idle server must not be
    // throttled to 1/Nth of a budget nobody else is asking for — it keeps 90
    // of 100, with one newcomer's share held in reserve.
    const budget = shared();
    let granted = 0;
    for (let i = 0; i < 100; i += 1) {
      if (budget.acquire('lonely', 1000).granted) granted += 1;
    }
    expect(granted).toBe(90);
  });

  it('keeps a share free for a client that has not arrived yet', () => {
    const budget = shared();
    while (budget.acquire('hog', 1000).granted) {
      /* spend everything the hog is allowed */
    }
    // The newcomer was never seen before this moment and still gets its share.
    for (let i = 0; i < 10; i += 1) {
      expect(budget.acquire('newcomer', 1000).granted).toBe(true);
    }
  });

  it('holds a heavy client to its reservation once the window is contended', () => {
    const budget = shared();
    // Five other clients active, so 6 shares (5 + 1 newcomer) are held back
    // and the burst limit for anyone else is 100 - 60 = 40.
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 8; j += 1) {
        expect(budget.acquire(`filler-${i}`, 1000).granted).toBe(true);
      }
    }

    // The heavy client has spent nothing, so it may spend its reservation.
    for (let i = 0; i < 10; i += 1) {
      expect(budget.acquire('heavy', 1000).granted).toBe(true);
    }

    // Beyond it, with the window contended, it is refused — bound by its own
    // share rather than by the global budget, which still has room.
    const refused = budget.acquire('heavy', 1000);
    expect(refused.granted).toBe(false);
    expect(refused.boundBy).toBe('client');
  });

  it('never lets a heavy client starve a light one', () => {
    // The scenario in the round numbers of the real thing: one caller runs a
    // 50-company screen while somebody else just wants a single lookup.
    const budget = shared();

    let heavyGranted = 0;
    for (let i = 0; i < 200; i += 1) {
      if (budget.acquire('heavy', 1000).granted) heavyGranted += 1;
    }
    expect(heavyGranted).toBeLessThan(100);
    expect(heavyGranted).toBeGreaterThan(0);

    // The light client has touched nothing, so its whole reservation is intact.
    for (let i = 0; i < 10; i += 1) {
      expect(budget.acquire('light', 1000).granted).toBe(true);
    }
  });

  it('does not enforce shares at all when no reservation is configured', () => {
    // stdio: one caller, nobody to be fair to, no reason to pay for it.
    const budget = build();
    expect(budget.fairShareEnabled).toBe(false);
    let granted = 0;
    for (let i = 0; i < 100; i += 1) {
      if (budget.acquire('only', 1000).granted) granted += 1;
    }
    expect(granted).toBe(100);
  });
});

describe('SlidingWindowBudget — peek agrees with acquire', () => {
  it('reports exactly what can then be spent, while quiet', () => {
    const budget = build({ clientReservation: 10 });
    const promised = budget.peek('a', 1000).remaining;

    let actual = 0;
    for (let i = 0; i < promised + 5; i += 1) {
      if (budget.acquire('a', 1000).granted) actual += 1;
    }
    expect(actual).toBe(promised);
  });

  it('reports exactly what can then be spent, while contended', () => {
    const budget = build({ clientReservation: 10 });
    for (let i = 0; i < 60; i += 1) budget.acquire(`filler-${i}`, 1000);

    const promised = budget.peek('late', 1000).remaining;
    let actual = 0;
    for (let i = 0; i < promised + 5; i += 1) {
      if (budget.acquire('late', 1000).granted) actual += 1;
    }
    expect(actual).toBe(promised);
  });

  it('spends nothing itself', () => {
    const budget = build();
    for (let i = 0; i < 20; i += 1) budget.peek('a', 1000);
    expect(budget.peek('a', 1000).remaining).toBe(100);
  });
});

describe('SlidingWindowBudget — penalties and server hints', () => {
  it('blocks everything until a penalty expires', () => {
    const budget = build();
    budget.penalise(5000);

    const refused = budget.acquire('a', 1000);
    expect(refused.granted).toBe(false);
    expect(refused.boundBy).toBe('penalty');
    expect(refused.retryInMs).toBe(4000);

    expect(budget.acquire('a', 5000).granted).toBe(true);
  });

  it('takes a server hint as a correction, not as the source of truth', () => {
    const budget = build();
    budget.observe({ remaining: 2, recordedAtMs: 1000 });
    expect(budget.peek('a', 1000).remaining).toBe(2);
  });

  it('does not let a stale reset time expire a fresh count', () => {
    // Companies House sends these headers inconsistently. A response carrying
    // only a reset time, followed by one carrying only a count, used to leave
    // the old reset in place — which expired the new count the instant it was
    // read, discarding the server's warning and running us into 429s.
    const budget = build();
    budget.observe({ resetAtMs: 2000, recordedAtMs: 1000 });
    budget.observe({ remaining: 3, recordedAtMs: 3000 });

    expect(budget.peek('a', 3000).remaining).toBe(3);
  });

  it('expires a hint that came with no reset time, rather than deadlocking', () => {
    // A `remain: 0` with no `reset` is an undocumented header telling us to
    // stop forever. It gets one window, then we go back to our own count.
    const budget = build();
    budget.observe({ remaining: 0, recordedAtMs: 1000 });
    expect(budget.peek('a', 1000).remaining).toBe(0);
    expect(budget.peek('a', 1000 + WINDOW).remaining).toBe(100);
  });
});

describe('SlidingWindowBudget — retry times', () => {
  it('quotes the server reset when the server is what is blocking us', () => {
    // A `remain: 0` hint can block a window that still has local room. Quoting
    // the local oldest-entry expiry then reports a time minutes early, after
    // which the caller retries, is refused, and pays a round trip for it —
    // and `screen_companies` prints the number verbatim.
    const budget = build();
    budget.acquire('a', 1000);
    budget.observe({ remaining: 0, resetAtMs: 1000 + WINDOW * 2, recordedAtMs: 1000 });

    const outcome = budget.peek('a', 1000);
    expect(outcome.granted).toBe(false);
    // The local window would have said one window; the server says two.
    expect(outcome.retryInMs).toBeGreaterThan(WINDOW);
  });

  it('ignores a server reset time that is not what is blocking us', () => {
    const budget = build({ limit: 1 });
    budget.acquire('a', 1000);
    budget.observe({ remaining: 50, resetAtMs: 1000 + WINDOW * 10, recordedAtMs: 1000 });

    // Local budget is spent; the server has plenty. The wait is the local one.
    expect(budget.peek('a', 1000).retryInMs).toBeLessThanOrEqual(WINDOW);
  });
});

describe('SlidingWindowBudget — bounded memory', () => {
  it('forgets clients that fall out of the window', () => {
    const budget = build({ clientReservation: 10 });
    for (let i = 0; i < 50; i += 1) budget.acquire(`client-${i}`, 1000);

    // After a full window everything prunes, including the per-client entries.
    const state = () => {
      budget.peek('probe', 1000 + WINDOW + 1);
      return budget.toState();
    };
    expect(Object.keys(state().clients)).toHaveLength(0);
  });

  it('caps tracked clients against a burst of distinct identities', () => {
    const budget = build({ clientReservation: 1, maxTrackedClients: 10, newcomerAllowance: 0 });
    for (let i = 0; i < 40; i += 1) budget.acquire(`burst-${i}`, 1000);
    expect(Object.keys(budget.toState().clients).length).toBeLessThanOrEqual(10);
  });
});

describe('SlidingWindowBudget — state round-trips', () => {
  it('survives serialisation, so a Durable Object can be evicted and restored', () => {
    const original = build({ clientReservation: 10 });
    for (let i = 0; i < 30; i += 1) original.acquire('a', 1000);
    const before = original.peek('a', 1000);

    const restored = build({ clientReservation: 10 });
    restored.loadState(JSON.parse(JSON.stringify(original.toState())) as never);

    expect(restored.peek('a', 1000)).toEqual(before);
  });
});

describe('MemoryBudgetStore', () => {
  it('serialises concurrent acquisitions so the limit still holds', async () => {
    // Without serialisation, N concurrent callers all read the same budget,
    // all decide they may proceed, and the limiter has failed at exactly the
    // moment it mattered.
    const store = new MemoryBudgetStore({ limit: 10, windowMs: WINDOW, safetyMargin: 1 });
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => store.acquire('a', 1000))
    );
    expect(outcomes.filter((o) => o.granted)).toHaveLength(10);
  });
});
