import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { BudgetDurableObject } from '../src/cloudflare/budget-do.js';
import { createFetchHandler } from '../src/cloudflare/worker.js';
import { DurableObjectBudgetStore } from '../src/cloudflare/do-budget-store.js';
import { KvCacheStore } from '../src/cloudflare/kv-cache-store.js';
import type {
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStub,
  KVNamespace
} from '../src/cloudflare/types.js';
import type { BudgetOutcome } from '../src/http/budget.js';
import type { RequestSnapshot } from '../src/telemetry/metrics.js';
import type { WorkerEnv, ExecutionContext } from '../src/cloudflare/types.js';

/**
 * The Cloudflare adapters, tested against stand-ins for the platform.
 *
 * Miniflare would exercise the real runtime and would also mean a second test
 * runner and a much slower suite for what is, in the end, three small classes
 * whose logic is entirely ours — the window arithmetic they wrap is already
 * covered in budget.test.ts. What these need proving is the wiring: that state
 * survives eviction, that the two kinds of window stay separate, and that an
 * unreachable limiter fails closed.
 */

function fakeState(): DurableObjectState & { dump: () => Record<string, unknown> } {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string): Promise<T | undefined> => storage.get(key) as T | undefined,
      put: async <T>(key: string, value: T): Promise<void> => {
        // Round-tripped through JSON, as the platform would.
        storage.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      }
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => callback(),
    dump: () => Object.fromEntries(storage)
  };
}

const OPTIONS = { limit: 10, windowMs: 300_000, safetyMargin: 1 };

async function call(
  object: BudgetDurableObject,
  body: Record<string, unknown>
): Promise<BudgetOutcome> {
  const response = await object.fetch(
    new Request('https://budget.invalid/', { method: 'POST', body: JSON.stringify(body) })
  );
  return (await response.json()) as BudgetOutcome;
}

describe('BudgetDurableObject', () => {
  it('enforces the window across separate requests', async () => {
    const object = new BudgetDurableObject(fakeState());

    for (let i = 0; i < 10; i += 1) {
      const outcome = await call(object, { op: 'acquire', clientId: 'a', now: 1000, options: OPTIONS });
      expect(outcome.granted).toBe(true);
    }

    const refused = await call(object, { op: 'acquire', clientId: 'a', now: 1000, options: OPTIONS });
    expect(refused.granted).toBe(false);
  });

  it('restores its window after eviction rather than handing out a fresh one', async () => {
    // The failure this prevents: the platform reclaims the object, a new one
    // starts empty, and every caller gets a brand-new allowance.
    const state = fakeState();
    const first = new BudgetDurableObject(state);
    for (let i = 0; i < 10; i += 1) {
      await call(first, { op: 'acquire', clientId: 'a', now: 1000, options: OPTIONS });
    }

    const afterEviction = new BudgetDurableObject(state);
    const outcome = await call(afterEviction, {
      op: 'acquire',
      clientId: 'a',
      now: 1000,
      options: OPTIONS
    });

    expect(outcome.granted).toBe(false);
  });

  it('applies fair shares only when the window it is given asks for them', async () => {
    // One class backs both the pooled window and every private one. A private
    // window must not lose a slice to shares nobody else can reach.
    const shared = new BudgetDurableObject(fakeState());
    const sharedOptions = { ...OPTIONS, clientReservation: 2, newcomerAllowance: 1 };
    let sharedGranted = 0;
    for (let i = 0; i < 10; i += 1) {
      const outcome = await call(shared, { op: 'acquire', clientId: 'a', now: 1000, options: sharedOptions });
      if (outcome.granted) sharedGranted += 1;
    }

    const private_ = new BudgetDurableObject(fakeState());
    let privateGranted = 0;
    for (let i = 0; i < 10; i += 1) {
      const outcome = await call(private_, { op: 'acquire', clientId: 'a', now: 1000, options: OPTIONS });
      if (outcome.granted) privateGranted += 1;
    }

    expect(privateGranted).toBe(10);
    expect(sharedGranted).toBeLessThan(10);
  });

  it('persists nothing for a refused request', async () => {
    const state = fakeState();
    const object = new BudgetDurableObject(state);
    await call(object, { op: 'peek', clientId: 'a', now: 1000, options: OPTIONS });
    expect(state.dump()).toEqual({});
  });

  it('rejects an operation with no window shape rather than inventing one', async () => {
    const object = new BudgetDurableObject(fakeState());
    const response = await object.fetch(
      new Request('https://budget.invalid/', {
        method: 'POST',
        body: JSON.stringify({ op: 'acquire', clientId: 'a', now: 1000 })
      })
    );
    expect(response.status).toBe(400);
  });

  it('retries the restore after a storage failure rather than latching it', async () => {
    // A cached rejected promise would turn one bad read into an object that
    // failed closed forever; a cached empty budget would hand out a fresh
    // allowance, which is worse. Neither: the next request tries again.
    let failNext = true;
    const storage = new Map<string, unknown>();
    const state: DurableObjectState = {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> => {
          if (failNext) {
            failNext = false;
            throw new Error('storage unavailable');
          }
          return storage.get(key) as T | undefined;
        },
        put: async <T>(key: string, value: T): Promise<void> => {
          storage.set(key, JSON.parse(JSON.stringify(value)) as unknown);
        }
      },
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => callback()
    };

    const object = new BudgetDurableObject(state);

    const failed = await object.fetch(
      new Request('https://budget.invalid/', {
        method: 'POST',
        body: JSON.stringify({ op: 'acquire', clientId: 'a', now: 1000, options: OPTIONS })
      })
    );
    expect(failed.status).toBe(503);

    // Second attempt: storage is healthy again and the object works.
    const recovered = await call(object, {
      op: 'acquire',
      clientId: 'a',
      now: 1000,
      options: OPTIONS
    });
    expect(recovered.granted).toBe(true);
  });

  it('ignores persisted state whose per-client entries are the wrong shape', async () => {
    // The container being an object is not enough: `loadState` spreads each
    // value and `#prune` calls `.shift()` on it, so a non-array here throws
    // inside blockConcurrencyWhile — one level deeper than a shallow check
    // looks, and with the same permanent consequence.
    const storage = new Map<string, unknown>([
      ['budget', { timestamps: [1], clients: { a: 'not-an-array' }, blockedUntil: 0 }]
    ]);
    const state: DurableObjectState = {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> => storage.get(key) as T | undefined,
        put: async <T>(key: string, value: T): Promise<void> => {
          storage.set(key, JSON.parse(JSON.stringify(value)) as unknown);
        }
      },
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => callback()
    };

    const outcome = await call(new BudgetDurableObject(state), {
      op: 'acquire',
      clientId: 'a',
      now: 1000,
      options: OPTIONS
    });
    expect(outcome.granted).toBe(true);
  });

  it('builds one window when two first requests arrive together', async () => {
    // Guarding on the built budget alone lets two concurrent first requests
    // each restore a window; the later assignment wins and the slot granted
    // against the discarded one disappears from the persisted count.
    const storage = new Map<string, unknown>();
    let restores = 0;
    const state: DurableObjectState = {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> => {
          restores += 1;
          // Yield, so a second caller can arrive mid-restore.
          await Promise.resolve();
          return storage.get(key) as T | undefined;
        },
        put: async <T>(key: string, value: T): Promise<void> => {
          storage.set(key, JSON.parse(JSON.stringify(value)) as unknown);
        }
      },
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => callback()
    };

    const object = new BudgetDurableObject(state);
    const [a, b] = await Promise.all([
      call(object, { op: 'acquire', clientId: 'x', now: 1000, options: OPTIONS }),
      call(object, { op: 'acquire', clientId: 'x', now: 1000, options: OPTIONS })
    ]);

    expect(restores).toBe(1);
    // Both were granted against the same window, so they are distinct draws.
    expect([a.granted, b.granted]).toEqual([true, true]);
    expect(a.remaining).not.toBe(b.remaining);
  });

  it('ignores persisted state whose server-hint fields are not numbers', async () => {
    // Worse than a crash: a non-numeric `serverRemaining` makes the available
    // count NaN, which passes the `<= 0` guard and reaches screen_companies as
    // `slice(0, NaN)` — every company reported unaffordable against a budget
    // that was never spent.
    const storage = new Map<string, unknown>([
      [
        'budget',
        { timestamps: [], clients: {}, blockedUntil: 0, serverRemaining: 'lots' }
      ]
    ]);
    const state: DurableObjectState = {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> => storage.get(key) as T | undefined,
        put: async <T>(key: string, value: T): Promise<void> => {
          storage.set(key, JSON.parse(JSON.stringify(value)) as unknown);
        }
      },
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => callback()
    };

    const outcome = await call(new BudgetDurableObject(state), {
      op: 'acquire',
      clientId: 'a',
      now: 1000,
      options: OPTIONS
    });

    expect(outcome.granted).toBe(true);
    expect(Number.isFinite(outcome.remaining)).toBe(true);
  });

  it('rejects a body that parses to something other than an object', async () => {
    // `JSON.parse('null')` succeeds. Reading `.options` off it throws outside
    // both try blocks, and the store reads that failure as an unreachable
    // window — failing the caller closed over what should be a plain 400.
    const object = new BudgetDurableObject(fakeState());
    for (const body of ['null', '42', '"a string"', '[]']) {
      const response = await object.fetch(
        new Request('https://budget.invalid/', { method: 'POST', body })
      );
      expect(response.status).toBe(400);
    }
  });

  it('does not write the whole window just to record a server hint', async () => {
    // `observe` runs after every upstream response. Persisting there would
    // roughly double storage traffic on the request path for a correction the
    // code itself treats as never being the source of truth.
    const state = fakeState();
    const object = new BudgetDurableObject(state);

    await call(object, {
      op: 'observe',
      hint: { remaining: 5, recordedAtMs: 1000 },
      options: OPTIONS
    });
    expect(state.dump()).toEqual({});

    // A penalty is different: a 429 must survive an eviction.
    await call(object, { op: 'penalise', resetAtMs: 9000, options: OPTIONS });
    expect(Object.keys(state.dump())).toContain('budget');
  });

  it('rejects a malformed body', async () => {
    const object = new BudgetDurableObject(fakeState());
    const response = await object.fetch(
      new Request('https://budget.invalid/', { method: 'POST', body: '{ not json' })
    );
    expect(response.status).toBe(400);
  });
});

describe('DurableObjectBudgetStore', () => {
  function namespaceFor(objects: Map<string, BudgetDurableObject>): DurableObjectNamespace {
    return {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id): DurableObjectStub => ({
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
    };
  }

  it('routes two credentials to two separate windows', async () => {
    const objects = new Map<string, BudgetDurableObject>();
    const namespace = namespaceFor(objects);

    const pooled = new DurableObjectBudgetStore({
      namespace,
      budgetName: 'key-pooled',
      budgetOptions: OPTIONS
    });
    const private_ = new DurableObjectBudgetStore({
      namespace,
      budgetName: 'client-private',
      budgetOptions: OPTIONS
    });

    for (let i = 0; i < 10; i += 1) await pooled.acquire('a', 1000);

    expect((await pooled.acquire('a', 1000)).granted).toBe(false);
    expect((await private_.acquire('a', 1000)).granted).toBe(true);
  });

  it('fails closed when the window cannot be reached', async () => {
    // Failing open would let every isolate decide independently that it had a
    // full allowance — the exact failure this design removed, arriving during
    // the incident that made the limiter unreachable.
    const store = new DurableObjectBudgetStore({
      namespace: {
        idFromName: (name) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            throw new Error('durable object unreachable');
          }
        })
      },
      budgetName: 'key-pooled',
      budgetOptions: OPTIONS
    });

    const outcome = await store.acquire('a', 1000);
    expect(outcome.granted).toBe(false);
    expect(outcome.retryInMs).toBeGreaterThan(0);
  });

  it('does not fail a successful request because a hint could not be recorded', async () => {
    // `observe` runs after every single Companies House response. If a Durable
    // Object hiccup threw here, a 200 the upstream already answered would be
    // turned into a failed request over a correction we did not need.
    const store = new DurableObjectBudgetStore({
      namespace: {
        idFromName: (name) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            throw new Error('durable object unreachable');
          }
        })
      },
      budgetName: 'key-pooled',
      budgetOptions: OPTIONS
    });

    await expect(store.observe({ remaining: 5, recordedAtMs: 1000 })).resolves.toBeUndefined();
    await expect(store.penalise(2000)).resolves.toBeUndefined();
  });

  it('reports an unreachable window as unavailable, not as a rate limit', async () => {
    // Telling a caller they have exhausted a 600-request budget, when in fact
    // the coordinator is down, is a wrong diagnosis that sends them away to
    // wait for a reset with nothing to do with their problem.
    const store = new DurableObjectBudgetStore({
      namespace: {
        idFromName: (name) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => {
            throw new Error('durable object unreachable');
          }
        })
      },
      budgetName: 'key-pooled',
      budgetOptions: OPTIONS
    });

    expect((await store.acquire('a', 1000)).boundBy).toBe('unavailable');
  });

  it('ignores persisted state it cannot read rather than refusing forever', async () => {
    // Durable Object storage outlives any deploy. Throwing on a value written
    // by an older shape of this code would refuse that credential's window
    // permanently, because the bad value stays in storage.
    const storage = new Map<string, unknown>([['budget', { unexpected: true }]]);
    const state: DurableObjectState = {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> => storage.get(key) as T | undefined,
        put: async <T>(key: string, value: T): Promise<void> => {
          storage.set(key, JSON.parse(JSON.stringify(value)) as unknown);
        }
      },
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => callback()
    };

    const object = new BudgetDurableObject(state);
    const outcome = await call(object, { op: 'acquire', clientId: 'a', now: 1000, options: OPTIONS });

    expect(outcome.granted).toBe(true);
  });

  it('can be told to fail open, for an operator who would rather risk the key', async () => {
    const store = new DurableObjectBudgetStore({
      namespace: {
        idFromName: (name) => ({ toString: () => name }),
        get: () => ({
          fetch: async () => new Response('nope', { status: 500 })
        })
      },
      budgetName: 'key-pooled',
      budgetOptions: OPTIONS,
      failOpen: true
    });

    expect((await store.acquire('a', 1000)).granted).toBe(true);
  });
});

describe('KvCacheStore', () => {
  function fakeKv(): KVNamespace & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      store,
      get: async (key) => store.get(key) ?? null,
      put: async (key, value) => {
        store.set(key, value);
      },
      delete: async (key) => {
        store.delete(key);
      }
    };
  }

  it('round-trips an entry', async () => {
    const kv = fakeKv();
    const cache = new KvCacheStore({ namespace: kv });
    const entry = { body: { hello: 'world' }, storedAt: 1000, ttlMs: 5000 };

    await cache.write('k', entry);
    expect(await cache.read('k')).toEqual(entry);
  });

  it('reports a miss for an unknown key', async () => {
    const cache = new KvCacheStore({ namespace: fakeKv() });
    expect(await cache.read('nope')).toBeUndefined();
  });

  it('ignores an entry written by an older shape of this code', async () => {
    // A KV namespace outlives any single deploy, so this is a normal event.
    const kv = fakeKv();
    kv.store.set('k', JSON.stringify({ unexpected: true }));
    expect(await new KvCacheStore({ namespace: kv }).read('k')).toBeUndefined();
  });

  it('ignores an entry that is not JSON at all', async () => {
    const kv = fakeKv();
    kv.store.set('k', '{ not json');
    expect(await new KvCacheStore({ namespace: kv }).read('k')).toBeUndefined();
  });

  it('never fails a request because the cache is broken', async () => {
    const broken: KVNamespace = {
      get: async () => {
        throw new Error('kv is down');
      },
      put: async () => {
        throw new Error('kv is down');
      },
      delete: async () => undefined
    };
    const cache = new KvCacheStore({ namespace: broken });

    await expect(cache.read('k')).resolves.toBeUndefined();
    await expect(cache.write('k', { body: {}, storedAt: 0, ttlMs: 1 })).resolves.toBeUndefined();
  });

  it('respects the minimum expiry KV will accept', async () => {
    const kv = fakeKv();
    let seen: number | undefined;
    const spy: KVNamespace = {
      ...kv,
      put: async (key, value, options) => {
        seen = options?.expirationTtl;
        await kv.put(key, value);
      }
    };

    await new KvCacheStore({ namespace: spy, expirationTtlSeconds: 5 }).write('k', {
      body: {},
      storedAt: 0,
      ttlMs: 1
    });

    expect(seen).toBeGreaterThanOrEqual(60);
  });
});

describe('the Worker fetch handler', () => {
  const ctx: ExecutionContext = { waitUntil: () => undefined };

  function env(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
    const objects = new Map<string, BudgetDurableObject>();
    return {
      COMPANIES_HOUSE_API_KEY: 'pooled-test-key',
      CH_CACHE_ENABLED: 'false',
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

  it('reports the real package version rather than a placeholder', async () => {
    // The version is inlined at build time because a Worker has no
    // package.json to read. Reporting 0.0.0 to every connecting host is
    // misleading in the one situation where the number matters: working out
    // which build is actually running.
    const expected = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
      .version;

    const response = await createFetchHandler()(
      new Request('https://worker.test/health'),
      env(),
      ctx
    );

    expect(await response.json()).toEqual({ status: 'ok', version: expected });
  });

  it('does not tell an unauthenticated caller which variables are misconfigured', async () => {
    // Whoever is calling an authless endpoint is unauthenticated, and the
    // state of the operator's environment is none of their business.
    const response = await createFetchHandler()(
      new Request('https://worker.test/mcp', { method: 'POST', body: '{}' }),
      { CH_CACHE_ENABLED: 'false' } as WorkerEnv,
      ctx
    );

    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('misconfigured');
    expect(body).not.toContain('COMPANIES_HOUSE_API_KEY');
  });

  it('says so plainly when the Durable Object binding is missing', async () => {
    const response = await createFetchHandler()(
      new Request('https://worker.test/mcp', { method: 'POST', body: '{}' }),
      { COMPANIES_HOUSE_API_KEY: 'k' } as WorkerEnv,
      ctx
    );

    expect(response.status).toBe(500);
  });

  it.each(['GET', 'DELETE'])('answers %s with 405 rather than opening a stream', async (method) => {
    // The Worker is stateless, so there is no notification stream to hold open
    // and no session to delete. Letting a GET through built a session, opened
    // an SSE stream, and then tore it down in the `finally` before the
    // response left — so a client would reconnect forever, paying a full
    // config parse, auth and Durable Object wiring each time.
    const response = await createFetchHandler()(
      new Request('https://worker.test/mcp', { method }),
      env(),
      ctx
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('404s a path that is not the MCP endpoint', async () => {
    const response = await createFetchHandler()(
      new Request('https://worker.test/'),
      env(),
      ctx
    );
    expect(response.status).toBe(404);
  });

  it('rejects a browser origin that was not allow-listed', async () => {
    const response = await createFetchHandler()(
      new Request('https://worker.test/mcp', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
        body: '{}'
      }),
      env(),
      ctx
    );
    expect(response.status).toBe(403);
  });

  it('completes an initialize handshake', async () => {
    const response = await createFetchHandler()(
      new Request('https://worker.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        })
      }),
      env(),
      ctx
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe('companies-house');
  });
});

describe('what the Worker measures', () => {
  const ctx: ExecutionContext = { waitUntil: () => undefined };
  const PROFILE = readFileSync('tests/fixtures/company/profile-active.json', 'utf8');

  function env(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
    const objects = new Map<string, BudgetDurableObject>();
    return {
      COMPANIES_HOUSE_API_KEY: 'pooled-test-key',
      CH_CACHE_ENABLED: 'false',
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

  /**
   * Drives a real request through the Worker and returns the rows it wrote.
   *
   * The sink is injected rather than read back off a dataset because there is
   * nothing to read it back from: Miniflare's Analytics Engine binding is a
   * no-op, and the real one is write-only from inside a Worker. This is the
   * only place the whole path — tool call, cache, limiter, flush — can be
   * asserted end to end.
   */
  async function rowsFor(
    body: unknown,
    options: { fetchImpl?: typeof fetch; headers?: Record<string, string> } = {}
  ): Promise<RequestSnapshot[]> {
    const rows: RequestSnapshot[] = [];
    const handler = createFetchHandler({
      metricsSink: { write: (snapshot) => rows.push(snapshot) },
      version: '9.9.9',
      fetchImpl:
        options.fetchImpl ??
        (async () =>
          new Response(PROFILE, { status: 200, headers: { 'content-type': 'application/json' } }))
    });

    await handler(
      new Request('https://worker.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...options.headers
        },
        body: JSON.stringify(body)
      }),
      env(),
      ctx
    );

    return rows;
  }

  const call = (name: string, args: Record<string, unknown>): unknown => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args }
  });

  it('writes exactly one row per invocation', async () => {
    // Not one per upstream call. The platform caps `writeDataPoint` at 250 per
    // invocation and a fifty-company screen makes roughly 150 upstream
    // requests, so per-call writes would drop the tail of the biggest runs.
    const rows = await rowsFor(call('get_company', { company_number: '04138203' }));
    expect(rows).toHaveLength(1);
  });

  it('records the tool, the outcome and what the call cost', async () => {
    const [row] = await rowsFor(call('get_company', { company_number: '04138203' }));

    expect(row).toMatchObject({
      tool: 'get_company',
      outcome: 'ok',
      upstreamRequests: 1,
      cacheMisses: 1,
      cacheHits: 0
    });
    expect(row?.budgetRemaining).toBeGreaterThan(0);
  });

  it('counts a composite call as the four requests it really makes', async () => {
    const [row] = await rowsFor(call('company_snapshot', { company_number: '04138203' }));

    expect(row?.tool).toBe('company_snapshot');
    expect(row?.upstreamRequests).toBe(4);
  });

  it('does not carry the query or the company number into a successful row', async () => {
    const rows = await rowsFor(call('find_company', { query: 'GREGGS PLC' }));
    const written = JSON.stringify(rows);

    expect(written).not.toContain('GREGGS');
    expect(written).not.toContain('greggs');
    expect(written).not.toContain('pooled-test-key');
  });

  it('does not carry them into a FAILING row either', async () => {
    // The path that could actually leak, and the one the first version of this
    // test missed by firing at a success. Error *messages* in this codebase do
    // embed the caller's input — `errors.ts` interpolates the identifier into
    // "Companies House has no company 04138203" — so a change recording
    // `error.message` instead of `error.code` would publish it. Only the code
    // is recorded, and only if it is in the allowlist.
    const rows = await rowsFor(call('get_company', { company_number: '04138203' }), {
      fetchImpl: async () =>
        new Response(JSON.stringify({ errors: [{ error: 'company-profile-not-found' }] }), {
          status: 404,
          headers: { 'content-type': 'application/json' }
        })
    });

    expect(rows[0]).toMatchObject({ outcome: 'error', errorCode: 'resource_not_found' });
    const written = JSON.stringify(rows);
    expect(written).not.toContain('04138203');
    expect(written).not.toContain('company-profile-not-found');
    expect(written).not.toContain('company-information');
  });

  it('records a failure as an error with its code, not as a success', async () => {
    const [row] = await rowsFor(call('get_company', { company_number: '04138203' }), {
      fetchImpl: async () =>
        new Response(JSON.stringify({ errors: [{ error: 'not-found' }] }), {
          status: 404,
          headers: { 'content-type': 'application/json' }
        })
    });

    expect(row).toMatchObject({ outcome: 'error', errorCode: 'resource_not_found' });
  });

  it('records a caller who brought their own key', async () => {
    const [row] = await rowsFor(call('get_company', { company_number: '04138203' }), {
      headers: { 'x-companies-house-api-key': 'a-caller-supplied-key' }
    });

    expect(row?.ownKey).toBe(true);
    expect(JSON.stringify(row)).not.toContain('a-caller-supplied-key');
  });

  it('writes a row even when the request never reaches a tool', async () => {
    // A handshake is still a request, and a deployment answering nothing but
    // handshakes is a fact worth being able to see.
    const rows = await rowsFor({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool).toBe('unknown');
  });

  it('writes nothing for a health check or a wrong path', async () => {
    // Otherwise uptime probes bury every row that says something.
    const rows: RequestSnapshot[] = [];
    const handler = createFetchHandler({
      metricsSink: { write: (snapshot) => rows.push(snapshot) }
    });

    await handler(new Request('https://worker.test/health'), env(), ctx);
    await handler(new Request('https://worker.test/'), env(), ctx);
    await handler(new Request('https://worker.test/mcp', { method: 'GET' }), env(), ctx);

    expect(rows).toHaveLength(0);
  });

  it('keeps each invocation independent, on one handler', async () => {
    // Deliberately reuses a single handler and a single env, because that is
    // the deployed shape: `export default { fetch: createFetchHandler() }`
    // builds the handler once and every request in the isolate runs through
    // it. Building a fresh handler per call — which the first version of this
    // test did — manufactures the independence it claims to observe, and a
    // recorder hoisted out of the request function passed the whole suite.
    const rows: RequestSnapshot[] = [];
    const handler = createFetchHandler({
      metricsSink: { write: (snapshot) => rows.push(snapshot) },
      fetchImpl: async () =>
        new Response(PROFILE, { status: 200, headers: { 'content-type': 'application/json' } })
    });
    const shared = env();

    for (const number of ['08880001', '08880002', '08880003']) {
      await handler(
        new Request('https://worker.test/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
          },
          body: JSON.stringify(call('get_company', { company_number: number }))
        }),
        shared,
        ctx
      );
    }

    expect(rows).toHaveLength(3);
    // One each, not 1/2/3. A shared recorder would accumulate.
    expect(rows.map((row) => row.upstreamRequests)).toEqual([1, 1, 1]);
    expect(rows.map((row) => row.cacheMisses)).toEqual([1, 1, 1]);
  });

  it('does not let a caller\'s own key latch on for every later request', async () => {
    // The other half of the same hazard: `ownKey` is a boolean, so a recorder
    // shared across the isolate would report every subsequent caller as
    // bringing a key after the first one did.
    const rows: RequestSnapshot[] = [];
    const handler = createFetchHandler({
      metricsSink: { write: (snapshot) => rows.push(snapshot) },
      fetchImpl: async () =>
        new Response(PROFILE, { status: 200, headers: { 'content-type': 'application/json' } })
    });
    const shared = env();

    const send = async (headers: Record<string, string>): Promise<void> => {
      await handler(
        new Request('https://worker.test/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers
          },
          body: JSON.stringify(call('get_company', { company_number: '08880010' }))
        }),
        shared,
        ctx
      );
    };

    await send({ 'x-companies-house-api-key': 'a-caller-supplied-key' });
    await send({});

    expect(rows.map((row) => row.ownKey)).toEqual([true, false]);
  });

  it.each(['client', 'global', 'penalty', 'unavailable'] as const)(
    'records a refusal bound by %s, with its cause',
    async (boundBy) => {
      // The four causes are four different operational problems, and the
      // refusal query groups by exactly this column. Before this test,
      // deleting `metrics.refused(...)` from the limiter entirely passed the
      // whole suite — the refusal half of the wiring was never observed.
      const rows: RequestSnapshot[] = [];
      const refusing: WorkerEnv = {
        COMPANIES_HOUSE_API_KEY: 'pooled-test-key',
        CH_CACHE_ENABLED: 'false',
        CH_MAX_WAIT_MS: '1',
        RATE_LIMIT: {
          idFromName: (name: string) => ({ toString: () => name }),
          get: () => ({
            fetch: async () =>
              new Response(
                JSON.stringify({
                  granted: false,
                  remaining: 0,
                  globalRemaining: 0,
                  retryInMs: 60_000,
                  limit: 570,
                  boundBy
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
              )
          })
        }
      };

      const handler = createFetchHandler({
        metricsSink: { write: (snapshot) => rows.push(snapshot) },
        fetchImpl: async () => new Response(PROFILE, { status: 200 })
      });

      await handler(
        new Request('https://worker.test/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
          },
          body: JSON.stringify(call('get_company', { company_number: '04138203' }))
        }),
        refusing,
        ctx
      );

      expect(rows[0]).toMatchObject({
        tool: 'get_company',
        outcome: 'refused',
        refusalCause: boundBy,
        upstreamRequests: 0
      });
      expect(rows[0]?.refusals).toBeGreaterThan(0);
    }
  );

  it('records a deployment failure as an error, not as a success', async () => {
    // Every early exit used to flush a row saying `ok`, so a wholly broken
    // deployment charted as 100% healthy — the exact blindness this feature
    // exists to remove.
    const rows: RequestSnapshot[] = [];
    const handler = createFetchHandler({
      metricsSink: { write: (snapshot) => rows.push(snapshot) }
    });
    const post = (body: unknown, env2: WorkerEnv, headers: Record<string, string> = {}) =>
      handler(
        new Request('https://worker.test/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers
          },
          body: JSON.stringify(body)
        }),
        env2,
        ctx
      );

    // A missing key: 500, and it must not read as a healthy request.
    await post({}, { CH_CACHE_ENABLED: 'false' } as WorkerEnv);
    // A missing Durable Object binding.
    await post({}, { COMPANIES_HOUSE_API_KEY: 'k' } as WorkerEnv);
    // A browser origin nobody allow-listed.
    await post({}, env({ CH_ALLOWED_ORIGINS: 'https://good.test' }), {
      origin: 'https://evil.test'
    });

    expect(rows.map((row) => row.outcome)).toEqual(['error', 'error', 'error']);
    expect(rows.map((row) => row.errorCode)).toEqual([
      'misconfigured',
      'misconfigured',
      'origin_rejected'
    ]);
  });

  it.each([
    ['a malformed body', 'not json at all'],
    ['an unknown tool', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } })],
    ['an unknown method', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope/at/all', params: {} })],
    ['arguments that fail the schema', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_company', arguments: { company_number: 12345 } } })]
  ])('records %s as a protocol error, not as a healthy request', async (_what, body) => {
    // The MCP SDK answers all of these itself, above `guard`, as ordinary
    // JSON-RPC error responses rather than exceptions. Nothing downstream ever
    // saw them, so a client sending garbage in a loop charted as healthy
    // traffic in the one column an operator alerts on.
    const rows: RequestSnapshot[] = [];
    const handler = createFetchHandler({
      metricsSink: { write: (snapshot) => rows.push(snapshot) },
      fetchImpl: async () => new Response(PROFILE, { status: 200 })
    });

    await handler(
      new Request('https://worker.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body
      }),
      env(),
      ctx
    );

    expect(rows[0]).toMatchObject({ outcome: 'error', errorCode: 'protocol_error' });
  });

  it('leaves a healthy handshake alone', async () => {
    // The inspection must not turn ordinary traffic into errors.
    const rows = await rowsFor({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }
    });

    expect(rows[0]).toMatchObject({ tool: 'unknown', outcome: 'ok', errorCode: '' });
  });

  it('does not re-read the body of a successful tool call', async () => {
    // Guarded on `tool === 'unknown'` so a fifty-company screen is never
    // parsed twice just to find out it succeeded.
    const [row] = await rowsFor(call('get_company', { company_number: '04138203' }));
    expect(row).toMatchObject({ tool: 'get_company', outcome: 'ok', errorCode: '' });
  });

  it('does not fail a request when the sink throws', async () => {
    // The sink runs in a `finally` after the answer is built. A throw there
    // would turn a good response into a 500.
    const handler = createFetchHandler({
      metricsSink: {
        write: () => {
          throw new Error('analytics is down');
        }
      },
      fetchImpl: async () =>
        new Response(PROFILE, { status: 200, headers: { 'content-type': 'application/json' } })
    });

    const response = await handler(
      new Request('https://worker.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(call('get_company', { company_number: '04138203' }))
      }),
      env(),
      ctx
    );

    expect(response.status).toBe(200);
  });
});
