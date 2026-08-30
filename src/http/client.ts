import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';
import type { Config } from '../config.js';
import { CompaniesHouseError, fromHttpStatus, malformedResponse, networkError, timeout } from '../errors.js';
import type { Logger } from '../telemetry/logger.js';
import { silentLogger } from '../telemetry/logger.js';
import type { MetricsRecorder } from '../telemetry/metrics.js';
import { silentMetrics } from '../telemetry/metrics.js';
import type { CacheEntry, CacheStore, ResourceKind } from './cache.js';
import { DEFAULT_TTLS, ResponseCache } from './cache.js';
import type { RateLimitSnapshot } from './rate-limiter.js';
import { DEFAULT_CLIENT_ID, RateLimiter } from './rate-limiter.js';

/**
 * The HTTP layer.
 *
 * Everything above this file deals in shaped domain objects; everything below
 * it deals in the Companies House API's actual behaviour — basic auth with a
 * blank password, a five-minute request budget, 404s that mean two different
 * things, and occasional HTML error pages served with a JSON content type.
 */

/**
 * Whatever a failed `fetch` can tell us, flattened for a log line.
 *
 * Runtimes disagree about what they throw: Node nests the useful part in
 * `cause`, workerd reports an opaque `internal error; reference = ...`, and
 * either may surface only a name. Take all of it, since one line in a log is
 * cheap and a second deploy to find out is not.
 */
function describeCause(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [`${error.name}: ${error.message}`];
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) parts.push(`caused by ${cause.name}: ${cause.message}`);
  else if (cause !== undefined) parts.push(`caused by ${String(cause)}`);
  return parts.join(' | ');
}

/**
 * Base64 without `Buffer`.
 *
 * `Buffer` is a Node global. This file has to run unchanged on Workers, where
 * it exists only behind a compatibility flag, so the encoding goes through the
 * Web standard instead. Routed via `TextEncoder` rather than calling `btoa`
 * directly because `btoa` throws on anything outside Latin-1, and an API key
 * with an unexpected character should not become a cryptic DOMException.
 */
function toBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface QueryParams {
  [key: string]: string | number | boolean | undefined;
}

export interface GetOptions {
  /** Path relative to the base URL, e.g. `/company/00000006`. */
  path: string;
  query?: QueryParams;
  /** Drives the cache TTL. Defaults to `other`. */
  resource?: ResourceKind;
  /** Human-readable noun used in error messages, e.g. `company`. */
  label?: string;
  /** Identifier used in error messages, e.g. the company number. */
  identifier?: string;
  /** Overrides the TTL for this call. */
  ttlMs?: number;
  /** Skips the cache read. The write still happens. */
  bypassCache?: boolean;
  signal?: AbortSignal;
}

export interface RequestMeta {
  /** Served from cache without contacting Companies House. */
  cached: boolean;
  /** Cache entry was revalidated with If-None-Match and the server said 304. */
  revalidated: boolean;
  /** Served from an expired cache entry because the upstream call failed. */
  stale: boolean;
  attempts: number;
  durationMs: number;
  /** Age of the cached answer. Absent when the answer came from the network. */
  ageMs?: number | undefined;
  rateLimit: RateLimitSnapshot;
}

export interface ClientResponse<T> {
  data: T;
  meta: RequestMeta;
}

export interface CompaniesHouseClientOptions {
  config: Config;
  logger?: Logger;
  clock?: Clock;
  cache?: ResponseCache;
  /**
   * Durable tier for the default cache. Ignored when `cache` is supplied.
   * Entry points pass this rather than a path, because the portable core has
   * no filesystem to point a path at.
   */
  cacheStore?: CacheStore | undefined;
  limiter?: RateLimiter;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  random?: () => number;
  /**
   * Identity this client spends the budget as.
   *
   * Only meaningful when the budget enforces fair shares, which is to say on a
   * shared HTTP deployment. stdio leaves it at the default because there is
   * one caller and nobody to be fair to. See `withClientId`.
   */
  clientId?: string | undefined;
  /**
   * Where this request's activity is counted. Defaults to counting nothing.
   *
   * Per request rather than per client, because the thing an operator wants
   * to read is "what did that call cost" — a counter shared across every
   * session would answer a question nobody asks.
   */
  metrics?: MetricsRecorder | undefined;
}

/** Statuses worth trying again. Everything else is the caller's problem. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class CompaniesHouseClient {
  readonly #config: Config;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #cache: ResponseCache;
  readonly #limiter: RateLimiter;
  readonly #fetch: typeof fetch;
  readonly #random: () => number;
  readonly #authorization: string;
  readonly #clientId: string;
  readonly #metrics: MetricsRecorder;
  /**
   * Requests currently in flight, by cache key.
   *
   * The cache only helps once an answer exists. Ten sessions screening the
   * same supplier list start together and all miss, so without this they make
   * ten identical calls and spend ten slots of a budget the whole point was to
   * conserve — `screen_companies` fans out concurrently by design, so this is
   * the common case rather than a race. Followers wait for the leader's answer
   * and are reported as cached, which is exactly what happened to them: they
   * were served without contacting Companies House.
   *
   * Keyed per client instance and therefore per session; the cache underneath
   * is what carries a result between sessions.
   */
  readonly #inFlight = new Map<string, Promise<ClientResponse<unknown>>>();
  /**
   * Budget last seen *by this client*.
   *
   * Not read off the limiter: `withClientId` shares one limiter across every
   * pooled session, so the limiter's cached figure belongs to whichever caller
   * acquired most recently. Reporting that in this session's response metadata
   * would attribute another caller's spending — including a `remaining: 0` —
   * to a request that may have been served entirely from cache.
   */
  #lastRateLimit: RateLimitSnapshot;

  constructor(options: CompaniesHouseClientOptions) {
    const { config } = options;
    this.#config = config;
    this.#logger = options.logger ?? silentLogger;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
    this.#metrics = options.metrics ?? silentMetrics;
    // Bound, not merely referenced. Node tolerates a detached `fetch`;
    // workerd requires `globalThis` as the receiver and throws
    // `TypeError: Illegal invocation` otherwise — so storing the bare global
    // here made every upstream request fail on Cloudflare while every test
    // under Node passed. The injected implementation is used as given, since a
    // test double has no such requirement.
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

    this.#cache =
      options.cache ??
      new ResponseCache({
        store: options.cacheStore,
        enabled: config.cacheEnabled,
        clock: this.#clock,
        logger: this.#logger
      });

    this.#limiter =
      options.limiter ??
      new RateLimiter({
        limit: config.rateLimit,
        windowMs: config.rateWindowMs,
        safetyMargin: config.rateSafetyMargin,
        clock: this.#clock,
        random: this.#random,
        metrics: this.#metrics,
        // Unset means wait, which is stdio's long-standing behaviour and the
        // right one for a single local caller. Servers pass a ceiling.
        ...(config.maxWaitMs === undefined ? {} : { maxWaitMs: config.maxWaitMs })
      });

    // Companies House uses HTTP basic auth with the API key as the username
    // and an ignored, empty password. The trailing colon is required.
    this.#authorization = `Basic ${toBase64(`${config.apiKey}:`)}`;
    this.#clientId = options.clientId ?? DEFAULT_CLIENT_ID;
    // Seeded from the ceiling rather than the shared limiter's cached value:
    // this session has spent nothing, and inheriting the previous caller's
    // figure is the same cross-session leak the field exists to prevent.
    this.#lastRateLimit = {
      remaining: this.#limiter.effectiveLimit,
      resetInMs: 0,
      limit: this.#limiter.effectiveLimit,
      globalRemaining: this.#limiter.effectiveLimit
    };
  }

  /**
   * A view of this client that spends the budget as `clientId`.
   *
   * Deliberately shares the cache and the limiter with the original rather
   * than building its own. Those two are the whole point of a hosted
   * deployment: one warm cache serving every session, and one window that all
   * of them are counted against. What varies per session is only *whose share*
   * a request comes out of, which is a single field. See ADR 13.
   */
  withClientId(clientId: string): CompaniesHouseClient {
    return new CompaniesHouseClient({
      config: this.#config,
      logger: this.#logger,
      clock: this.#clock,
      cache: this.#cache,
      limiter: this.#limiter,
      fetchImpl: this.#fetch,
      random: this.#random,
      metrics: this.#metrics,
      clientId
    });
  }

  /**
   * Last budget this session saw. Cheap, slightly behind on a shared
   * deployment, and correct for reporting what a call just cost.
   */
  get rateLimit(): RateLimitSnapshot {
    return this.#lastRateLimit;
  }

  /**
   * Authoritative budget for `clientId`, at the cost of a round trip.
   *
   * Anything that *plans* against the budget must use this rather than the
   * cached getter. On a shared server the cached number can be an entire
   * window out of date, and `screen_companies` sizing a batch against a stale
   * figure is exactly the silently-short table ADR 8 forbids.
   */
  async budget(clientId?: string): Promise<RateLimitSnapshot> {
    const snapshot = await this.#limiter.snapshot(clientId ?? this.#clientId);
    this.#lastRateLimit = snapshot;
    return snapshot;
  }

  get cache(): ResponseCache {
    return this.#cache;
  }

  async get<T>(options: GetOptions): Promise<ClientResponse<T>> {
    const startedAt = this.#clock.now();
    const url = this.#buildUrl(options.path, options.query);
    const resource = options.resource ?? 'other';
    const ttlMs = options.ttlMs ?? DEFAULT_TTLS[resource];
    const label = options.label ?? resource;
    const key = ResponseCache.key('GET', url);

    const lookup = options.bypassCache === true ? { state: 'miss' as const } : await this.#cache.get(key);

    if (lookup.state === 'fresh') {
      this.#logger.debug('cache hit', { url, resource });
      this.#metrics.cacheHit();
      return {
        data: lookup.entry.body as T,
        meta: {
          cached: true,
          revalidated: false,
          stale: false,
          attempts: 0,
          durationMs: this.#clock.now() - startedAt,
          ageMs: this.#clock.now() - lookup.entry.storedAt,
          rateLimit: this.#lastRateLimit
        }
      };
    }

    const staleEntry = lookup.state === 'stale' ? lookup.entry : undefined;

    // Somebody is already asking for exactly this. Wait for their answer
    // rather than making the same call and spending a second slot: a
    // `screen_companies` fan-out issues its requests concurrently, so
    // duplicates within a batch are the design rather than a coincidence.
    // A caller that asked to bypass the cache is asking for a fresh read and
    // gets one.
    const existing = options.bypassCache === true ? undefined : this.#inFlight.get(key);
    if (existing !== undefined) {
      try {
        const shared = (await existing) as ClientResponse<T>;
        // Counted only once the leader has actually answered. Recording the
        // hit before the await counted a follower whose leader then failed —
        // a request that was served nothing at all.
        this.#metrics.cacheHit();
        return {
          data: shared.data,
          meta: {
            ...shared.meta,
            // True in the sense the field means: served without contacting
            // Companies House. This request made no call and spent no budget.
            cached: true,
            durationMs: this.#clock.now() - startedAt,
            rateLimit: this.#lastRateLimit
          }
        };
      } catch (error) {
        // The leader failed. This request holds its own stale entry and is
        // entitled to the same fallback a leader would get — previously the
        // await sat outside every `try`, so a follower was rejected while the
        // leader beside it was served an hour-old answer.
        const fallback = this.#staleFallback<T>(staleEntry, error, url, startedAt);
        if (fallback !== undefined) {
          // Still a hit: this request contacted nobody and spent nothing.
          // Without it four of five coalesced requests served from cache
          // appeared in neither cache column and the hit rate read zero.
          this.#metrics.cacheHit();
          return fallback;
        }
        throw error;
      }
    }

    this.#metrics.cacheMiss();

    try {
      const pending = this.#fetchWithRetries<T>({
        url,
        key,
        ttlMs,
        label,
        resource,
        startedAt,
        staleEntry,
        identifier: options.identifier,
        signal: options.signal
      });

      if (options.bypassCache !== true) {
        this.#inFlight.set(key, pending as Promise<ClientResponse<unknown>>);
      }

      try {
        return await pending;
      } finally {
        // Cleared whether it resolved or threw: a failed request must not
        // leave a rejected promise that every later caller adopts.
        this.#inFlight.delete(key);
      }
    } catch (error) {
      const fallback = this.#staleFallback<T>(staleEntry, error, url, startedAt);
      if (fallback !== undefined) return fallback;
      throw error;
    }
  }

  /**
   * An expired copy, when the upstream cannot be reached.
   *
   * An hour-old answer labelled as an hour old beats no answer, so long as the
   * caller can see that is what happened. Extracted so that a request which
   * waited on somebody else's failed fetch gets the same treatment as one that
   * made its own — those two were different before, and the difference was
   * invisible from either call site.
   */
  #staleFallback<T>(
    staleEntry: CacheEntry | undefined,
    error: unknown,
    url: string,
    startedAt: number
  ): ClientResponse<T> | undefined {
    if (staleEntry === undefined) return undefined;
    if (!CompaniesHouseError.is(error) || !error.retryable) return undefined;

    this.#metrics.staleServed();
    this.#logger.warn('serving stale cache entry after upstream failure', {
      url,
      code: error.code,
      ageMs: this.#clock.now() - staleEntry.storedAt
    });
    return {
      data: staleEntry.body as T,
      meta: {
        cached: true,
        revalidated: false,
        stale: true,
        attempts: this.#config.maxRetries + 1,
        durationMs: this.#clock.now() - startedAt,
        ageMs: this.#clock.now() - staleEntry.storedAt,
        rateLimit: this.#lastRateLimit
      }
    };
  }

  async #fetchWithRetries<T>(input: {
    url: string;
    key: string;
    ttlMs: number;
    label: string;
    resource: ResourceKind;
    startedAt: number;
    staleEntry: CacheEntry | undefined;
    identifier: string | undefined;
    signal: AbortSignal | undefined;
  }): Promise<ClientResponse<T>> {
    const { url, key, ttlMs, label, startedAt, staleEntry, identifier } = input;
    let lastError: CompaniesHouseError | undefined;

    for (let attempt = 0; attempt <= this.#config.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await this.#clock.sleep(this.#backoffMs(attempt, lastError));
      }

      // Taken from the return value, not read back off the shared limiter:
      // another session's continuation can run between the await resolving and
      // a read of shared state, and would then be reported as this session's.
      this.#lastRateLimit = await this.#limiter.acquire(this.#clientId);

      let response: Response;
      try {
        // Counted here rather than around the whole attempt: this is the line
        // that spends a slot of the key's window, and it is the number every
        // cost question comes back to. The retry is counted alongside it, and
        // after `acquire` — an attempt the limiter refuses never reaches the
        // network, and counting it made the retry rate read 100% for a request
        // that retried nothing.
        this.#metrics.upstreamRequest();
        if (attempt > 0) this.#metrics.upstreamRetry();
        response = await this.#fetch(url, {
          method: 'GET',
          headers: this.#headers(staleEntry),
          signal: this.#signal(input.signal)
        });
      } catch (error) {
        lastError = this.#classifyFetchFailure(error, label);
        // The underlying reason goes in the log, not in the error payload:
        // the caller gets a sanitised code (ADR 3), while whoever is operating
        // the server needs to know whether "could not reach Companies House"
        // meant DNS, TLS, a proxy, or a runtime that does not support
        // something. Without it a NETWORK_ERROR is a dead end for the one
        // person who could fix it.
        this.#logger.debug('request failed', {
          url,
          attempt,
          code: lastError.code,
          reason: describeCause(error)
        });
        if (!lastError.retryable) throw lastError;
        continue;
      }

      await this.#limiter.applyServerHeaders(response.headers);

      if (response.status === 304 && staleEntry !== undefined) {
        await this.#cache.refresh(key, staleEntry);
        return {
          data: staleEntry.body as T,
          meta: {
            cached: true,
            revalidated: true,
            stale: false,
            attempts: attempt + 1,
            durationMs: this.#clock.now() - startedAt,
            rateLimit: this.#lastRateLimit
          }
        };
      }

      if (response.ok) {
        const body = await this.#parseJson(response, label);
        const etag = response.headers.get('etag');
        await this.#cache.set(key, {
          body,
          storedAt: this.#clock.now(),
          ttlMs,
          ...(etag === null ? {} : { etag })
        });
        return {
          data: body as T,
          meta: {
            cached: false,
            revalidated: false,
            stale: false,
            attempts: attempt + 1,
            durationMs: this.#clock.now() - startedAt,
            rateLimit: this.#lastRateLimit
          }
        };
      }

      const retryAfterMs = this.#retryAfterMs(response.headers);
      if (response.status === 429) this.#metrics.upstreamThrottled();
      if (response.status === 429 && retryAfterMs !== undefined) {
        await this.#limiter.penalise(this.#clock.now() + retryAfterMs);
      }

      lastError = fromHttpStatus({
        status: response.status,
        resource: label,
        identifier,
        retryAfterMs,
        body: await this.#safeText(response)
      });

      if (!RETRYABLE_STATUSES.has(response.status)) throw lastError;
      this.#logger.debug('retryable status', { url, status: response.status, attempt });
    }

    throw (
      lastError ??
      new CompaniesHouseError({
        code: 'UPSTREAM_UNAVAILABLE',
        message: `Gave up fetching ${label} after ${this.#config.maxRetries + 1} attempts.`,
        nextStep: 'Retry shortly, or check the Companies House service status page.',
        retryable: true
      })
    );
  }

  #headers(staleEntry: CacheEntry | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: this.#authorization,
      accept: 'application/json',
      'user-agent': this.#config.userAgent
    };
    // Only sent when the API previously supplied a real HTTP ETag. The `etag`
    // field inside the JSON body is a different thing and is not a validator.
    if (staleEntry?.etag !== undefined) {
      headers['if-none-match'] = staleEntry.etag;
    }
    return headers;
  }

  #signal(callerSignal: AbortSignal | undefined): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(this.#config.timeoutMs);
    return callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal]);
  }

  #classifyFetchFailure(error: unknown, label: string): CompaniesHouseError {
    if (CompaniesHouseError.is(error)) return error;
    const name = (error as { name?: string } | undefined)?.name;
    if (name === 'TimeoutError') return timeout(label, this.#config.timeoutMs);
    if (name === 'AbortError') {
      return new CompaniesHouseError({
        code: 'UPSTREAM_TIMEOUT',
        message: `The request for ${label} was cancelled before it completed.`,
        nextStep: 'Retry the call.',
        retryable: false,
        cause: error
      });
    }
    return networkError(label, error);
  }

  async #parseJson(response: Response, label: string): Promise<unknown> {
    const text = await response.text();
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw malformedResponse(label, error);
    }
  }

  async #safeText(response: Response): Promise<string | undefined> {
    try {
      const text = await response.text();
      // Enough to diagnose, short enough not to bloat a log line.
      return text.slice(0, 500);
    } catch {
      return undefined;
    }
  }

  /**
   * Full-jitter exponential backoff. A fixed backoff synchronises every client
   * that started at the same moment, which is how a transient blip becomes a
   * sustained one.
   */
  #backoffMs(attempt: number, lastError: CompaniesHouseError | undefined): number {
    if (lastError?.retryAfterMs !== undefined) return lastError.retryAfterMs;
    const ceiling = Math.min(this.#config.retryBaseMs * 2 ** (attempt - 1), 30_000);
    return Math.floor(this.#random() * ceiling) + 1;
  }

  #retryAfterMs(headers: Headers): number | undefined {
    const raw = headers.get('retry-after');
    if (raw === null) return undefined;

    const seconds = Number.parseInt(raw, 10);
    if (Number.isFinite(seconds) && String(seconds) === raw.trim()) return seconds * 1000;

    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(date - this.#clock.now(), 0);

    return undefined;
  }

  #buildUrl(path: string, query: QueryParams | undefined): string {
    const url = new URL(path.startsWith('/') ? path.slice(1) : path, `${this.#config.baseUrl}/`);
    if (query !== undefined) {
      // Sorted so that two callers passing the same parameters in a different
      // order share a cache entry.
      for (const [name, value] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
        if (value === undefined) continue;
        url.searchParams.set(name, String(value));
      }
    }
    return url.toString();
  }
}
