import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';
import { CompaniesHouseError } from '../errors.js';
import type { MetricsRecorder } from '../telemetry/metrics.js';
import { silentMetrics } from '../telemetry/metrics.js';
import type { BudgetBound, BudgetOutcome, SlidingWindowBudgetOptions } from './budget.js';
import type { BudgetStore } from './budget-store.js';
import { MemoryBudgetStore } from './budget-store.js';

/**
 * Rate limiting against the documented Companies House budget.
 *
 * The published limit is 600 requests per five-minute window per key; exceed
 * it and every further request in that window returns 429 until it resets.
 *
 * Two design notes worth keeping:
 *
 * - This is a *sliding* window over recorded request timestamps rather than a
 *   token bucket. A bucket refilling at two per second would smooth traffic
 *   nicely and would also make `screen_companies` over thirty suppliers take
 *   a minute for no reason. The real constraint permits bursts; the limiter
 *   should too.
 *
 * - Companies House does return `X-Ratelimit-*` headers, but they are not in
 *   the published documentation. They are treated as a correction to a budget
 *   we already track locally, never as the source of truth. If they vanish
 *   tomorrow, nothing here changes behaviour.
 *
 * What this class is now: the *waiting* half. All the arithmetic moved into
 * `SlidingWindowBudget` behind a `BudgetStore`, so the same window can be held
 * in this process or in a Durable Object shared by every session. This class
 * decides how long to wait and when to give up, which is a policy question
 * that belongs to the caller's runtime rather than to the shared window.
 *
 * The safety margin still applies, and still exists because the budget belongs
 * to the *key*, not to this process — a cron job on the same key is invisible
 * to any store. What has changed is that other *sessions* are no longer
 * invisible: they share the store, so the margin is now covering only the
 * traffic this deployment genuinely cannot see.
 */

export interface RateLimiterOptions extends SlidingWindowBudgetOptions {
  clock?: Clock;
  /** Upper bound on random jitter added to every wait, in milliseconds. */
  jitterMs?: number;
  random?: () => number;
  /**
   * Where the window lives. Defaults to an in-process store, which is correct
   * for stdio and for a single always-on instance.
   */
  store?: BudgetStore;
  /**
   * How long `acquire` will wait before giving up and raising RATE_LIMITED.
   *
   * A limiter that waits forever is fine for a CLI and wrong for a server: the
   * MCP client times out, the user sees a hang rather than an explanation, and
   * the request occupies a connection the whole time. Failing with a real
   * retry time is more useful than succeeding eventually.
   *
   * Defaults to no ceiling, so that adding this option did not silently change
   * what the stdio server had always done.
   */
  maxWaitMs?: number;
  /**
   * Where refusals and budget readings are counted.
   *
   * The limiter is the only place that knows *why* a request was turned away
   * — a spent share, a spent window, a 429 penalty, or a coordinator that
   * could not be reached are four different operational problems that all
   * look like "rate limited" from outside. Recording it anywhere else would
   * mean inferring it back from an error code that deliberately does not
   * carry the distinction. Defaults to recording nothing.
   */
  metrics?: MetricsRecorder;
}

export interface RateLimitSnapshot {
  /** Requests this caller may still make in the window. */
  remaining: number;
  /** Milliseconds until at least one more request becomes available. */
  resetInMs: number;
  /** The effective ceiling after the safety margin. */
  limit: number;
  /**
   * What is left in the whole window, as opposed to this caller's share.
   *
   * Carried so that a caller sizing a batch can tell which of the two bounds
   * is biting. `boundBy` cannot answer that on its own: it is set only when
   * something was actually refused, so a successful `peek` leaves it absent
   * and everything downstream had to guess.
   */
  globalRemaining: number;
  /**
   * Why the budget is zero, when it is.
   *
   * Carried through because `remaining: 0` has two very different meanings: a
   * spent window, which the caller should wait out, and a limiter that could
   * not be reached, which they should not. Dropping it here is what let
   * `screen_companies` describe an outage as an exhausted budget while the
   * single-lookup path was carefully avoiding exactly that.
   */
  boundBy?: BudgetBound | undefined;
}

/** Identity used when a caller does not distinguish itself. Correct for stdio. */
export const DEFAULT_CLIENT_ID = 'default';

/** No ceiling: waiting is the pre-existing stdio behaviour. Servers set one. */
const DEFAULT_MAX_WAIT_MS = Number.POSITIVE_INFINITY;

/** What the hosted entry points use when the operator has not chosen. */
export const SERVER_MAX_WAIT_MS = 60_000;

export class RateLimiter {
  readonly #clock: Clock;
  readonly #jitterMs: number;
  readonly #random: () => number;
  readonly #store: BudgetStore;
  readonly #maxWaitMs: number;
  readonly #effectiveLimit: number;
  readonly #metrics: MetricsRecorder;

  /**
   * Last outcome seen, so that response metadata can report the budget without
   * a round trip on a path that has already paid for one.
   */
  #lastKnown: RateLimitSnapshot;

  constructor(options: RateLimiterOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#jitterMs = options.jitterMs ?? 50;
    this.#random = options.random ?? Math.random;
    this.#maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.#metrics = options.metrics ?? silentMetrics;

    const store = options.store ?? new MemoryBudgetStore(options);
    this.#store = store;
    this.#effectiveLimit =
      store instanceof MemoryBudgetStore
        ? store.effectiveLimit
        : Math.max(1, Math.floor((options.limit ?? 600) * (options.safetyMargin ?? 0.95)));

    this.#lastKnown = {
      remaining: this.#effectiveLimit,
      resetInMs: 0,
      limit: this.#effectiveLimit,
      globalRemaining: this.#effectiveLimit
    };
  }

  /**
   * Resolves when the caller may make a request, waiting if necessary.
   *
   * Returns the budget as it stood for *this* acquisition, rather than leaving
   * the caller to read `lastKnown` afterwards. That is not a convenience: one
   * limiter is shared by every pooled session, so between an `await acquire()`
   * resolving and the caller reading shared state, another session's
   * continuation can run and overwrite it. Handing the value back closes that
   * window by construction.
   *
   * @throws {CompaniesHouseError} RATE_LIMITED when the wait would exceed
   * `maxWaitMs`. Callers that would rather resize their work than wait should
   * ask `snapshot` first — that is what `screen_companies` does.
   */
  async acquire(clientId: string = DEFAULT_CLIENT_ID): Promise<RateLimitSnapshot> {
    const startedAt = this.#clock.now();
    const deadline = startedAt + this.#maxWaitMs;
    let last: BudgetOutcome | undefined;

    // Bounded so that a pathological clock cannot spin here forever.
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const outcome = await this.#store.acquire(clientId, this.#clock.now());
      const snapshot = this.#remember(outcome);
      if (outcome.granted) return snapshot;
      last = outcome;

      // A window that cannot be consulted will not become consultable by being
      // asked sixty more times. Fail now, with a reason that says so, rather
      // than after a minute of round trips to something that is down.
      if (outcome.boundBy === 'unavailable') throw this.#refuse(outcome);

      const now = this.#clock.now();
      if (now + outcome.retryInMs > deadline) throw this.#refuse(outcome);

      await this.#clock.sleep(Math.max(outcome.retryInMs, 1) + this.#jitter());
    }

    // The bound is reachable with a perfectly healthy clock: a caller held to
    // its reservation while its own dense burst ages out can be refused many
    // times inside the wait window. That is congestion, and reporting it as an
    // internal error would tell the caller their request is a server bug and
    // not retryable, when it is neither.
    if (last !== undefined && this.#clock.now() > startedAt) throw this.#refuse(last);

    throw new Error('RateLimiter.acquire exceeded its retry bound; the injected clock is not advancing.');
  }

  /**
   * Authoritative view of what `clientId` may spend, without spending it.
   *
   * Async because on a shared deployment the answer is not in this process,
   * and a stale answer here becomes a `screen_companies` table that promises
   * rows the limiter then refuses.
   */
  async snapshot(clientId: string = DEFAULT_CLIENT_ID): Promise<RateLimitSnapshot> {
    const outcome = await this.#store.peek(clientId, this.#clock.now());
    return this.#remember(outcome);
  }

  /**
   * Last budget seen, without a round trip.
   *
   * For response metadata only. It is by definition slightly behind on a
   * shared deployment, which is acceptable for a number the caller reads
   * after the fact and not acceptable for one it plans against.
   */
  get lastKnown(): RateLimitSnapshot {
    return this.#lastKnown;
  }

  /** Records that the server rejected a request, and holds traffic until `resetAt`. */
  async penalise(resetAtMs: number): Promise<void> {
    await this.#store.penalise(resetAtMs);
  }

  /**
   * Folds Companies House rate-limit headers into the window.
   *
   * Header names follow the service's own spelling — `X-Ratelimit-Remain`,
   * not `Remaining`. Both are read because the shorter form is undocumented
   * and could change to the conventional one without notice.
   */
  async applyServerHeaders(headers: Headers): Promise<void> {
    const remainRaw = headers.get('x-ratelimit-remain') ?? headers.get('x-ratelimit-remaining');
    const resetRaw = headers.get('x-ratelimit-reset');

    let remaining: number | undefined;
    let resetAtMs: number | undefined;

    if (remainRaw !== null) {
      const parsed = Number.parseInt(remainRaw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) remaining = parsed;
    }

    if (resetRaw !== null) {
      const parsed = Number.parseInt(resetRaw, 10);
      if (Number.isFinite(parsed)) {
        // Documented nowhere, so accept both seconds and milliseconds since
        // the epoch by checking the magnitude.
        resetAtMs = parsed > 1e11 ? parsed : parsed * 1000;
      }
    }

    if (remaining === undefined && resetAtMs === undefined) return;
    await this.#store.observe({ remaining, resetAtMs, recordedAtMs: this.#clock.now() });
  }

  /** Test and diagnostic hook. Not part of the public contract. */
  get effectiveLimit(): number {
    return this.#effectiveLimit;
  }

  /**
   * Builds the refusal error, counting it on the way past.
   *
   * All three give-up paths route through here so that none of them can be
   * added later without being counted — which is the failure mode for
   * instrumentation generally: it is correct on the day it is written and
   * quietly incomplete a month later.
   */
  #refuse(outcome: BudgetOutcome): CompaniesHouseError {
    this.#metrics.refused(outcome.boundBy ?? 'global');
    return rateLimited(outcome);
  }

  #remember(outcome: BudgetOutcome): RateLimitSnapshot {
    this.#lastKnown = {
      remaining: outcome.remaining,
      resetInMs: outcome.granted ? 0 : outcome.retryInMs,
      limit: outcome.limit,
      globalRemaining: outcome.globalRemaining,
      boundBy: outcome.boundBy
    };
    // Every outcome passes through here, granted or not, so the figure
    // recorded is the state at the end of the request rather than at whichever
    // point somebody remembered to sample it.
    //
    // Except when nothing was read. An unreachable coordinator reports zero
    // for everything as a fail-closed placeholder, and recording that as a
    // real reading drew an outage as the budget collapsing — on request rows,
    // which are the ones an operator charts. The heartbeat already skipped it;
    // this is the same rule for the path that produces most of the data.
    if (outcome.boundBy !== 'unavailable') {
      // The window, not this caller's share of it — the same figure the
      // heartbeat records, so one column means one thing. They disagreed by a
      // whole reservation, and under a 429 hold a request row said "0 of 570"
      // while the window was almost untouched.
      this.#metrics.budget(outcome.globalRemaining, outcome.limit);
    }
    return this.#lastKnown;
  }

  #jitter(): number {
    return Math.floor(this.#random() * this.#jitterMs);
  }
}

export function budgetUnavailable(retryInMs: number): CompaniesHouseError {
  return rateLimited({
    granted: false,
    remaining: 0,
    retryInMs,
    limit: 0,
    globalRemaining: 0,
    boundBy: 'unavailable'
  });
}

function rateLimited(outcome: BudgetOutcome): CompaniesHouseError {
  const seconds = Math.ceil(outcome.retryInMs / 1000);

  if (outcome.boundBy === 'unavailable') {
    // Deliberately not phrased as a rate limit. The caller has not exceeded
    // anything, and sending them away to wait for a window reset would be a
    // wrong diagnosis of somebody else's outage.
    return new CompaniesHouseError({
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'The rate-limit coordinator could not be reached, so no request could be safely made.',
      nextStep:
        'This is a fault in this server, not in your request or your budget. Retry shortly; if it persists, check the deployment.',
      retryAfterMs: outcome.retryInMs,
      retryable: true
    });
  }

  const cause =
    outcome.boundBy === 'client'
      ? 'This session has used its share of the shared Companies House budget for the current five-minute window.'
      : 'The Companies House rate limit of 600 requests per five minutes has been reached.';

  return new CompaniesHouseError({
    code: 'RATE_LIMITED',
    message: cause,
    nextStep:
      outcome.boundBy === 'client'
        ? `Wait ${seconds} seconds, or supply your own Companies House API key to get a budget of your own.`
        : `Wait ${seconds} seconds before making further calls.`,
    retryAfterMs: outcome.retryInMs,
    retryable: true
  });
}
