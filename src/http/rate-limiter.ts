import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';

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
 * A safety margin is applied because the budget belongs to the *key*, not to
 * this process. If the same key is used by a cron job or a second editor
 * window, running to exactly 600 guarantees somebody gets a 429.
 */

export interface RateLimiterOptions {
  /** Documented request ceiling for the window. */
  limit?: number;
  windowMs?: number;
  /** Fraction of `limit` this process will use. 0.95 leaves 30 in reserve. */
  safetyMargin?: number;
  clock?: Clock;
  /** Upper bound on random jitter added to every wait, in milliseconds. */
  jitterMs?: number;
  random?: () => number;
}

export interface RateLimitSnapshot {
  /** Requests this process believes it may still make in the window. */
  remaining: number;
  /** Milliseconds until at least one more request becomes available. */
  resetInMs: number;
  /** The effective ceiling after the safety margin. */
  limit: number;
}

export class RateLimiter {
  readonly #limit: number;
  readonly #effectiveLimit: number;
  readonly #windowMs: number;
  readonly #clock: Clock;
  readonly #jitterMs: number;
  readonly #random: () => number;

  /** Timestamps of requests made inside the current window, oldest first. */
  #timestamps: number[] = [];
  /** Set after a 429 or a Retry-After. No request leaves before this time. */
  #blockedUntil = 0;
  /** Most recent server-reported remaining budget, when headers were present. */
  #serverRemaining: number | undefined;
  #serverResetAt: number | undefined;
  /** When the server hint was recorded, so it can expire without a reset header. */
  #serverRecordedAt: number | undefined;
  /** Serialises acquisition so concurrent callers cannot both pass the check. */
  #chain: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions = {}) {
    this.#limit = options.limit ?? 600;
    this.#windowMs = options.windowMs ?? 300_000;
    const margin = options.safetyMargin ?? 0.95;
    this.#effectiveLimit = Math.max(1, Math.floor(this.#limit * margin));
    this.#clock = options.clock ?? systemClock;
    this.#jitterMs = options.jitterMs ?? 50;
    this.#random = options.random ?? Math.random;
  }

  /**
   * Resolves when the caller may make a request, waiting if necessary.
   *
   * Acquisitions are serialised through a promise chain. Without it, ten
   * concurrent callers all read a budget of one, all decide they may proceed,
   * and the limiter has failed at precisely the moment it mattered.
   */
  acquire(): Promise<void> {
    const run = this.#chain.then(() => this.#acquireInner());
    // Keep the chain alive even if one acquisition rejects.
    this.#chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #acquireInner(): Promise<void> {
    // Bounded so that a pathological clock cannot spin here forever.
    for (let attempt = 0; attempt < 64; attempt += 1) {
      this.#prune();
      const now = this.#clock.now();

      if (now < this.#blockedUntil) {
        await this.#clock.sleep(this.#blockedUntil - now + this.#jitter());
        continue;
      }

      if (this.#availableNow(now) > 0) {
        this.#timestamps.push(now);
        if (this.#serverRemaining !== undefined && this.#serverRemaining > 0) {
          this.#serverRemaining -= 1;
        }
        return;
      }

      const oldest = this.#timestamps[0];
      const waitMs = oldest === undefined ? this.#windowMs : oldest + this.#windowMs - now;
      await this.#clock.sleep(Math.max(waitMs, 1) + this.#jitter());
    }

    throw new Error('RateLimiter.acquire exceeded its retry bound; the injected clock is not advancing.');
  }

  /** Records that the server rejected a request, and holds traffic until `resetAt`. */
  penalise(resetAtMs: number): void {
    this.#blockedUntil = Math.max(this.#blockedUntil, resetAtMs);
  }

  /**
   * Folds Companies House rate-limit headers into local state.
   *
   * Header names follow the service's own spelling — `X-Ratelimit-Remain`,
   * not `Remaining`. Both are read because the shorter form is undocumented
   * and could change to the conventional one without notice.
   */
  applyServerHeaders(headers: Headers): void {
    const remainRaw = headers.get('x-ratelimit-remain') ?? headers.get('x-ratelimit-remaining');
    const resetRaw = headers.get('x-ratelimit-reset');

    if (remainRaw !== null) {
      const parsed = Number.parseInt(remainRaw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        this.#serverRemaining = parsed;
        this.#serverRecordedAt = this.#clock.now();
      }
    }

    if (resetRaw !== null) {
      const parsed = Number.parseInt(resetRaw, 10);
      if (Number.isFinite(parsed)) {
        // Documented nowhere, so accept both seconds and milliseconds since
        // the epoch by checking the magnitude.
        this.#serverResetAt = parsed > 1e11 ? parsed : parsed * 1000;
      }
    }
  }

  snapshot(): RateLimitSnapshot {
    this.#prune();
    const now = this.#clock.now();
    const remaining = this.#availableNow(now);
    const oldest = this.#timestamps[0];

    let resetInMs = 0;
    if (remaining === 0) {
      resetInMs = oldest === undefined ? this.#windowMs : Math.max(oldest + this.#windowMs - now, 0);
    }
    if (now < this.#blockedUntil) {
      resetInMs = Math.max(resetInMs, this.#blockedUntil - now);
    }

    return { remaining, resetInMs, limit: this.#effectiveLimit };
  }

  /** Test and diagnostic hook. Not part of the public contract. */
  get effectiveLimit(): number {
    return this.#effectiveLimit;
  }

  #availableNow(now: number): number {
    const local = this.#effectiveLimit - this.#timestamps.length;
    if (this.#serverRemaining === undefined) return Math.max(local, 0);

    // The hint expires either at the reset time the server gave us or, when it
    // gave us none, one window after we recorded it. Without that second rule
    // a `remain: 0` header with no `reset` header would block this process
    // forever, which is a deadlock caused entirely by an undocumented field.
    const expired =
      this.#serverResetAt !== undefined
        ? now >= this.#serverResetAt
        : this.#serverRecordedAt !== undefined && now - this.#serverRecordedAt >= this.#windowMs;

    if (expired) {
      this.#serverRemaining = undefined;
      this.#serverResetAt = undefined;
      this.#serverRecordedAt = undefined;
      return Math.max(local, 0);
    }

    return Math.max(Math.min(local, this.#serverRemaining), 0);
  }

  #prune(): void {
    const cutoff = this.#clock.now() - this.#windowMs;
    let firstLive = 0;
    while (firstLive < this.#timestamps.length && this.#timestamps[firstLive]! <= cutoff) {
      firstLive += 1;
    }
    if (firstLive > 0) this.#timestamps = this.#timestamps.slice(firstLive);
  }

  #jitter(): number {
    return Math.floor(this.#random() * this.#jitterMs);
  }
}
