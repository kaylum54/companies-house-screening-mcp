import { describe, expect, it } from 'vitest';

import {
  alertEndpoint,
  decideAlert,
  INITIAL_ALERT_STATE,
  isAlertState,
  sendAlert
} from '../src/cloudflare/alerts.js';
import type { AlertState } from '../src/cloudflare/alerts.js';
import { BudgetDurableObject } from '../src/cloudflare/budget-do.js';
import { createScheduledHandler } from '../src/cloudflare/worker.js';
import type {
  DurableObjectState,
  ExecutionContext,
  KVNamespace,
  ScheduledController,
  WorkerEnv
} from '../src/cloudflare/types.js';
import type { BudgetOutcome } from '../src/http/budget.js';
import type { RequestSnapshot } from '../src/telemetry/metrics.js';

/**
 * Alerting, and the rules that keep it worth listening to.
 *
 * The failure mode for alerting is not silence, it is noise: a channel that
 * fires on every busy five minutes gets muted, and a muted channel is worse
 * than no channel because everybody still believes it works. Most of what
 * follows is about *not* sending.
 */

const reading = (over: Partial<BudgetOutcome> = {}): BudgetOutcome => ({
  granted: true,
  remaining: 400,
  retryInMs: 0,
  limit: 570,
  ...over
});

const EXHAUSTED = reading({ remaining: 10, granted: false });
const UNAVAILABLE = reading({ remaining: 0, granted: false, boundBy: 'unavailable', limit: 0 });

describe('decideAlert', () => {
  it('says nothing about a healthy window', () => {
    const decision = decideAlert(INITIAL_ALERT_STATE, reading(), 1_000);
    expect(decision.payload).toBeUndefined();
    expect(decision.state.firing).toBe(false);
  });

  it('holds its fire on a single bad reading', () => {
    // A busy five minutes legitimately drains the window. That is the design
    // working, not a fault, and waking somebody for it is how alerting dies.
    const decision = decideAlert(INITIAL_ALERT_STATE, EXHAUSTED, 1_000);
    expect(decision.payload).toBeUndefined();
    expect(decision.state.strikes).toBe(1);
    expect(decision.state.firing).toBe(false);
  });

  it('alerts once the window has failed to recover across a full period', () => {
    const first = decideAlert(INITIAL_ALERT_STATE, EXHAUSTED, 1_000);
    const second = decideAlert(first.state, EXHAUSTED, 301_000);

    expect(second.payload).toMatchObject({
      state: 'firing',
      reason: 'budget_exhausted',
      budgetRemaining: 10,
      budgetLimit: 570
    });
    expect(second.state.firing).toBe(true);
  });

  it('stays quiet while the same problem continues', () => {
    let state = decideAlert(INITIAL_ALERT_STATE, EXHAUSTED, 1_000).state;
    state = decideAlert(state, EXHAUSTED, 2_000).state;
    expect(state.firing).toBe(true);

    for (const at of [3_000, 4_000, 5_000]) {
      const next = decideAlert(state, EXHAUSTED, at);
      expect(next.payload).toBeUndefined();
      state = next.state;
    }
  });

  it('reports recovery exactly once, then resets', () => {
    // Somebody told about a problem is owed the end of it — and owed it only
    // once.
    let state = decideAlert(INITIAL_ALERT_STATE, EXHAUSTED, 1_000).state;
    state = decideAlert(state, EXHAUSTED, 2_000).state;

    const recovered = decideAlert(state, reading(), 3_000);
    expect(recovered.payload).toMatchObject({ state: 'resolved', reason: 'budget_exhausted' });
    expect(recovered.state).toEqual(INITIAL_ALERT_STATE);

    expect(decideAlert(recovered.state, reading(), 4_000).payload).toBeUndefined();
  });

  it('never reports a recovery that was never a problem', () => {
    expect(decideAlert(INITIAL_ALERT_STATE, reading(), 1_000).payload).toBeUndefined();
  });

  it('treats an unreachable limiter as its own problem, not an empty budget', () => {
    // An unreachable window reports `remaining: 0`, which reads as an
    // exhausted budget and would send the operator to look at traffic while
    // the coordinator is down.
    const first = decideAlert(INITIAL_ALERT_STATE, UNAVAILABLE, 1_000);
    const second = decideAlert(first.state, UNAVAILABLE, 2_000);

    expect(second.payload?.reason).toBe('limiter_unavailable');
    expect(second.payload?.text).toContain('Durable Object');
  });

  it('restarts the count when the cause changes', () => {
    // Two consecutive bad checks of *different* kinds is not the same
    // evidence as two of the same, so the bound starts again.
    const first = decideAlert(INITIAL_ALERT_STATE, EXHAUSTED, 1_000);
    const second = decideAlert(first.state, UNAVAILABLE, 2_000);

    expect(second.state.strikes).toBe(1);
    expect(second.payload).toBeUndefined();
  });

  it('alerts before the window is completely empty', () => {
    // At zero, callers have been refused for a while already. The useful
    // moment is while somebody could still act.
    const nearly = reading({ remaining: 28, limit: 570 });
    const first = decideAlert(INITIAL_ALERT_STATE, nearly, 1_000);
    expect(decideAlert(first.state, nearly, 2_000).payload).toBeDefined();
  });

  it('leaves a comfortable window alone', () => {
    const fine = reading({ remaining: 29, limit: 570 });
    expect(decideAlert(INITIAL_ALERT_STATE, fine, 1_000).state.strikes).toBe(0);
  });

  it('carries no caller identity or company number in the payload', () => {
    const first = decideAlert(INITIAL_ALERT_STATE, EXHAUSTED, 1_000);
    const payload = decideAlert(first.state, EXHAUSTED, 2_000).payload;
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      'at',
      'budgetLimit',
      'budgetRemaining',
      'reason',
      'state',
      'text'
    ]);
  });
});

describe('isAlertState', () => {
  const valid: AlertState = { firing: true, strikes: 2, since: 1, reason: 'budget_exhausted' };

  it('accepts a well-formed state', () => {
    expect(isAlertState(valid)).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'firing'],
    ['a missing field', { firing: true, strikes: 1, since: 0 }],
    ['a non-finite strike count', { ...valid, strikes: Number.NaN }],
    ['an infinite timestamp', { ...valid, since: Number.POSITIVE_INFINITY }],
    ['an unknown reason', { ...valid, reason: 'something_else' }]
  ])('rejects %s', (_label, value) => {
    // A malformed stored state would otherwise latch the alerting permanently
    // on or permanently off, and KV round-trips whatever was written to it.
    expect(isAlertState(value)).toBe(false);
  });
});

describe('alertEndpoint', () => {
  it('accepts an https URL', () => {
    expect(alertEndpoint('https://hooks.example/abc')?.host).toBe('hooks.example');
  });

  it.each([
    ['plain http, which would post an alert in clear text', 'http://hooks.example/abc'],
    ['a value that is not a URL', 'hooks.example/abc'],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a file URL', 'file:///etc/passwd']
  ])('refuses %s', (_label, value) => {
    expect(alertEndpoint(value)).toBeUndefined();
  });

  it('refuses an unset variable', () => {
    expect(alertEndpoint(undefined)).toBeUndefined();
  });
});

describe('sendAlert', () => {
  const payload = {
    state: 'firing' as const,
    reason: 'budget_exhausted' as const,
    text: 'x',
    budgetRemaining: 0,
    budgetLimit: 570,
    at: '2026-08-25T00:00:00.000Z'
  };

  it('posts the payload as JSON', async () => {
    let seen: { url: string; body: string } | undefined;
    const ok = await sendAlert({
      url: new URL('https://hooks.example/abc'),
      payload,
      fetchImpl: async (input, init) => {
        seen = { url: String(input), body: String(init?.body) };
        return new Response('', { status: 200 });
      }
    });

    expect(ok).toBe(true);
    expect(seen?.url).toBe('https://hooks.example/abc');
    expect(JSON.parse(seen?.body ?? '{}')).toMatchObject({ state: 'firing' });
  });

  it('reports a rejection without throwing', async () => {
    const ok = await sendAlert({
      url: new URL('https://hooks.example/abc'),
      payload,
      fetchImpl: async () => new Response('no', { status: 500 })
    });
    expect(ok).toBe(false);
  });

  it('survives a webhook that throws', async () => {
    // A scheduled run that dies here stops persisting state, so the strike
    // count never reaches the bound and alerting quietly stops working — in a
    // code path nobody is watching.
    const ok = await sendAlert({
      url: new URL('https://hooks.example/abc'),
      payload,
      fetchImpl: async () => {
        throw new Error('DNS is having a day');
      }
    });
    expect(ok).toBe(false);
  });
});

describe('the scheduled run', () => {
  const controller: ScheduledController = { scheduledTime: 0, cron: '*/5 * * * *' };
  const ctx: ExecutionContext = { waitUntil: () => undefined };

  function fakeState(): DurableObjectState {
    const store = new Map<string, unknown>();
    return {
      storage: {
        get: async <T>(key: string) => store.get(key) as T | undefined,
        put: async <T>(key: string, value: T) => void store.set(key, value)
      },
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback()
    };
  }

  function kv(): KVNamespace & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      get: async (key: string) => data.get(key) ?? null,
      put: async (key: string, value: string) => void data.set(key, value),
      delete: async (key: string) => void data.delete(key)
    };
  }

  function env(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
    const objects = new Map<string, BudgetDurableObject>();
    return {
      COMPANIES_HOUSE_API_KEY: 'pooled-test-key',
      RATE_LIMIT: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: (id) => ({
          fetch: async (_input, init) => {
            const name = id.toString();
            let object = objects.get(name);
            if (object === undefined) {
              object = new BudgetDurableObject(fakeState());
              objects.set(name, object);
            }
            return object.fetch(
              new Request('https://budget.invalid/', { method: 'POST', body: init?.body ?? '{}' })
            );
          }
        })
      },
      ...overrides
    };
  }

  it('leaves a heartbeat even when nothing is wrong', async () => {
    // Without one, a quiet hour and an outage look identical in the dataset,
    // and the budget cannot be charted over time at all.
    const rows: RequestSnapshot[] = [];
    await createScheduledHandler({ metricsSink: { write: (row) => rows.push(row) } })(
      controller,
      env(),
      ctx
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'heartbeat', outcome: 'ok' });
    expect(rows[0]?.budgetLimit).toBe(570);
  });

  it('spends none of the budget it is watching', async () => {
    // A check every five minutes that took a slot would consume 288 requests
    // a day of the allowance it exists to protect. Five identical readings is
    // the proof: `peek` looks, `acquire` would have spent.
    const rows: RequestSnapshot[] = [];
    const shared = env();
    const sink = { write: (row: RequestSnapshot) => rows.push(row) };

    for (let i = 0; i < 5; i += 1) {
      await createScheduledHandler({ metricsSink: sink })(controller, shared, ctx);
    }

    // 499, not 570: the check reads the pooled window as an unknown caller
    // would see it, so the figure is what a newcomer could spend right now
    // rather than the raw global remainder. That is the number worth alerting
    // on — it answers "is the next person through the door going to be
    // refused" — and because a share is bounded by what is globally
    // available, it can only fall this low when the window really is spent.
    expect(rows.map((row) => row.budgetRemaining)).toEqual([499, 499, 499, 499, 499]);
  });

  it('sends nothing when no webhook is configured', async () => {
    let called = false;
    await createScheduledHandler({
      fetchImpl: async () => {
        called = true;
        return new Response('');
      }
    })(controller, env({ CACHE: kv() }), ctx);

    expect(called).toBe(false);
  });

  it('says so out loud when the webhook is set but unusable', async () => {
    // An operator who has set a webhook believes alerting is on. Declining
    // silently would leave them trusting a channel that will never fire.
    const said: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => said.push(String(message));
    try {
      await createScheduledHandler()(
        controller,
        env({ CACHE: kv(), CH_ALERT_WEBHOOK_URL: 'http://insecure.example/x' }),
        ctx
      );
    } finally {
      console.error = original;
    }

    expect(said.join(' ')).toContain('no alerts will be sent');
    // The rejected value is a capability URL. It must not end up in a log.
    expect(said.join(' ')).not.toContain('insecure.example');
  });

  it('says so out loud when the webhook is set but KV is not bound', async () => {
    const said: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => said.push(String(message));
    try {
      await createScheduledHandler()(
        controller,
        env({ CH_ALERT_WEBHOOK_URL: 'https://hooks.example/x' }),
        ctx
      );
    } finally {
      console.error = original;
    }

    expect(said.join(' ')).toContain('CACHE binding is missing');
    expect(said.join(' ')).not.toContain('hooks.example');
  });

  it('stays quiet when no webhook is configured at all', async () => {
    // Nothing to warn about: this is the default and it is a valid choice.
    const said: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => said.push(String(message));
    try {
      await createScheduledHandler()(controller, env({ CACHE: kv() }), ctx);
    } finally {
      console.error = original;
    }

    expect(said).toEqual([]);
  });

  it('refuses to alert without KV, because it cannot count strikes', async () => {
    // Alerting with no hysteresis fires on every blip. Declining is the
    // honest answer; the guide says KV is required for alerting.
    let called = false;
    await createScheduledHandler({
      fetchImpl: async () => {
        called = true;
        return new Response('');
      }
    })(controller, env({ CH_ALERT_WEBHOOK_URL: 'https://hooks.example/x' }), ctx);

    expect(called).toBe(false);
  });

  it('does not alert on the first bad check, and does on the second', async () => {
    const posted: string[] = [];
    const cache = kv();
    // A limiter that cannot be reached: the Durable Object refuses every call.
    const broken = env({
      CACHE: cache,
      CH_ALERT_WEBHOOK_URL: 'https://hooks.example/x',
      RATE_LIMIT: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            throw new Error('coordinator unreachable');
          }
        })
      }
    });

    const handler = createScheduledHandler({
      fetchImpl: async (_input, init) => {
        posted.push(String(init?.body));
        return new Response('', { status: 200 });
      }
    });

    await handler(controller, broken, ctx);
    expect(posted).toHaveLength(0);

    await handler(controller, broken, ctx);
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0] ?? '{}')).toMatchObject({
      state: 'firing',
      reason: 'limiter_unavailable'
    });

    // And then stays quiet rather than repeating every five minutes.
    await handler(controller, broken, ctx);
    expect(posted).toHaveLength(1);
  });

  it('carries on when the configuration is broken rather than throwing', async () => {
    // Nobody is watching a scheduled run. An exception here is invisible.
    await expect(
      createScheduledHandler()(controller, {} as WorkerEnv, ctx)
    ).resolves.toBeUndefined();
  });

  it('carries on when the Durable Object binding is missing', async () => {
    await expect(
      createScheduledHandler()(
        controller,
        { COMPANIES_HOUSE_API_KEY: 'k' } as WorkerEnv,
        ctx
      )
    ).resolves.toBeUndefined();
  });
});
