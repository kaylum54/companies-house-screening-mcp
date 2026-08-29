/**
 * The parts of the Workers runtime this server actually touches.
 *
 * Declared structurally rather than by depending on `@cloudflare/workers-types`
 * because that package installs a global environment — its `fetch`, `Request`
 * and `Response` replace the Node ones for the entire project — and this
 * repository typechecks Node entry points, Node tests and Worker code in one
 * pass. Importing it would make the Node half stop compiling.
 *
 * The cost is that these declarations must stay true to the platform; the
 * benefit is that one `npm run typecheck` still covers everything. Only the
 * handful of members used below are declared, so the surface that could drift
 * is small.
 */

export interface KVNamespace {
  get(key: string, type: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(input: string, init?: { method?: string; body?: string }): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Workers Analytics Engine.
 *
 * `writeDataPoint` returns void and is not awaited by the platform: it is
 * queued and delivered outside the request. That is exactly the property
 * wanted here — measurement must not be able to slow a request down or fail
 * one — and it is also why nothing downstream can confirm a write.
 */
export interface AnalyticsEngineDataset {
  writeDataPoint(event: {
    indexes?: string[];
    blobs?: string[];
    doubles?: number[];
  }): void;
}

/** Fired by a Cron Trigger. `scheduledTime` is milliseconds since the epoch. */
export interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

/** Bindings and variables the Worker expects, as declared in wrangler.toml. */
export interface WorkerEnv extends Record<string, unknown> {
  COMPANIES_HOUSE_API_KEY?: string;
  /** Durable Object holding the authoritative rate-limit window. */
  RATE_LIMIT?: DurableObjectNamespace;
  /** KV namespace backing the shared response cache. Optional; memory-only without it. */
  CACHE?: KVNamespace;
  /** Analytics Engine dataset. Optional; nothing is measured without it. */
  ANALYTICS?: AnalyticsEngineDataset;
}
