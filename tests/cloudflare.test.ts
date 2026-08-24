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
