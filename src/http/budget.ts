/**
 * Rate-limit budget: who may spend the Companies House allowance, and when.
 *
 * Companies House allows 600 requests per five minutes **per key**. The
 * original limiter tracked that in one process and applied a safety margin,
 * because the budget belongs to the key and a second process using the same
 * key was invisible to it. That was an honest mitigation for stdio, where the
 * second process is an editor window. It stops being adequate the moment one
 * key backs a hosted server: the budget is then shared by strangers, and a
 * margin cannot make an unshared counter correct.
 *
 * Two things follow, and this file is both of them.
 *
 * **The window has to be authoritative, not local.** The algorithm below is
 * deliberately pure — it takes `now` as an argument, owns no clock, and does
 * no I/O — so that the exact same code can run in a single Node process and
 * inside a Cloudflare Durable Object. A Durable Object is single-threaded and
 * globally unique per key, which makes "check the budget and reserve a slot"
 * genuinely atomic rather than atomic-if-there-is-only-one-instance. Writing
 * the algorithm once and hosting it twice is the only way those two answers
 * stay the same. See ADR 13.
 *
 * **One caller must not be able to starve the others.** A single
 * `screen_companies` over fifty suppliers can spend 150 requests, a quarter of
 * the whole window, and three of them would exhaust it. So each client gets a
 * guaranteed reservation it can always spend, and may spend beyond it only
 * while the shared budget is below a burst threshold.
 *
 * That rule is work-conserving on purpose. A lone user on a quiet server can
 * still use the entire budget — the reservation is a floor under everyone
 * else, not a ceiling on them — so the common case does not get slower to
 * protect against a crowd that is not there. Only once the window is genuinely
 * contended does the limiter start holding heavy callers to their share, and
 * the callers it holds back are by construction the ones that have already had
 * the most. Anything that does not fit degrades into the `not_screened` shape
 * ADR 8 already defines, with a real reset time, rather than failing.
 */

/** What the server told us about the budget, when it bothered to. */
export interface ServerRateLimitHint {
  remaining?: number | undefined;
  resetAtMs?: number | undefined;
  recordedAtMs: number;
}

/**
 * Which constraint stopped a request, when one did.
 *
 * `unavailable` is not a constraint at all — it means the window could not be
 * consulted. It is distinguished because telling a caller they have hit a rate
 * limit, when in fact the limiter is down, sends them away to wait for a reset
 * that has nothing to do with their problem.
 */
export type BudgetBound = 'global' | 'client' | 'penalty' | 'unavailable';

export interface BudgetOutcome {
  granted: boolean;
  /** What this client may still spend right now. */
  remaining: number;
  /** Milliseconds until at least one more request frees up. Zero when granted. */
  retryInMs: number;
  /** The effective ceiling after the safety margin. */
  limit: number;
  /** Absent when granted. */
  boundBy?: BudgetBound | undefined;
}

export interface SlidingWindowBudgetOptions {
  /** Documented request ceiling for the window. */
  limit?: number;
  windowMs?: number;
  /** Fraction of `limit` this budget will use. 0.95 leaves 30 in reserve. */
  safetyMargin?: number;
  /**
   * Slots every client is guaranteed within a window.
   *
   * `undefined` disables fair sharing entirely, which is the correct setting
   * for stdio: there is exactly one client, and giving it a share of its own
   * budget would only make it slower. HTTP entry points set it.
   */
  clientReservation?: number | undefined;
  /**
   * How many not-yet-seen clients to keep a reservation free for.
   *
   * This is what stops a busy client from spending the budget down to nothing
   * before a newcomer has said a word. One is usually right: it costs a single
   * reservation of headroom and guarantees the next arrival is not met with an
   * empty window.
   */
  newcomerAllowance?: number;
  /** Bound on distinct clients tracked, so an open endpoint cannot grow memory without limit. */
  maxTrackedClients?: number;
}

const DEFAULT_LIMIT = 600;
const DEFAULT_WINDOW_MS = 300_000;
const DEFAULT_SAFETY_MARGIN = 0.95;
const DEFAULT_NEWCOMER_ALLOWANCE = 1;
const DEFAULT_MAX_TRACKED_CLIENTS = 10_000;

/**
 * Serialisable state, so a Durable Object can persist and restore a budget
 * across evictions without knowing anything about how it works.
 */
export interface BudgetState {
  timestamps: number[];
  clients: Record<string, number[]>;
  blockedUntil: number;
  serverRemaining?: number | undefined;
  serverResetAt?: number | undefined;
  serverRecordedAt?: number | undefined;
}

/**
 * Validates persisted state before it is loaded.
 *
 * Durable Object storage outlives any single deploy, exactly as a KV namespace
 * does — and cache entries get `isCacheEntry` for precisely this reason. An
 * unvalidated load throws inside `blockConcurrencyWhile`, and because the bad
 * value stays in storage the credential's window is then refused forever
 * rather than degrading. Ignoring an unreadable state costs one window's worth
 * of history; trusting it costs the window.
 */
export function isBudgetState(value: unknown): value is BudgetState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate['timestamps']) &&
    candidate['timestamps'].every((entry) => typeof entry === 'number') &&
    typeof candidate['clients'] === 'object' &&
    candidate['clients'] !== null &&
    !Array.isArray(candidate['clients']) &&
    typeof candidate['blockedUntil'] === 'number'
  );
}

export class SlidingWindowBudget {
  readonly #limit: number;
  readonly #effectiveLimit: number;
  readonly #windowMs: number;
  readonly #clientReservation: number | undefined;
  readonly #newcomerAllowance: number;
  readonly #maxTrackedClients: number;

  /** Timestamps of requests made inside the current window, oldest first. */
  #timestamps: number[] = [];
  /** Per-client timestamps, for fair sharing. Empty when sharing is disabled. */
  #clients = new Map<string, number[]>();
  /** Set after a 429 or a Retry-After. No request leaves before this time. */
  #blockedUntil = 0;
  #serverRemaining: number | undefined;
  #serverResetAt: number | undefined;
  #serverRecordedAt: number | undefined;

  constructor(options: SlidingWindowBudgetOptions = {}) {
    this.#limit = options.limit ?? DEFAULT_LIMIT;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    const margin = options.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
    this.#effectiveLimit = Math.max(1, Math.floor(this.#limit * margin));
    this.#clientReservation =
      options.clientReservation === undefined
        ? undefined
        : Math.max(1, Math.floor(options.clientReservation));
    this.#newcomerAllowance = Math.max(0, options.newcomerAllowance ?? DEFAULT_NEWCOMER_ALLOWANCE);
    this.#maxTrackedClients = options.maxTrackedClients ?? DEFAULT_MAX_TRACKED_CLIENTS;
  }

  get effectiveLimit(): number {
    return this.#effectiveLimit;
  }

  get windowMs(): number {
    return this.#windowMs;
  }

  /** True when this budget enforces per-client shares as well as the global window. */
  get fairShareEnabled(): boolean {
    return this.#clientReservation !== undefined;
  }

  /**
   * Attempts to reserve one slot for `clientId`.
   *
   * Reserves on success and reserves nothing on failure, so a caller that is
   * refused has not silently consumed part of the budget it was told it could
   * not use.
   */
  acquire(clientId: string, now: number): BudgetOutcome {
    this.#prune(now);

    if (now < this.#blockedUntil) {
      return {
        granted: false,
        remaining: 0,
        retryInMs: this.#blockedUntil - now,
        limit: this.#effectiveLimit,
        boundBy: 'penalty'
      };
    }

    const globalAvailable = this.#globalAvailable(now);
    if (globalAvailable <= 0) {
      return {
        granted: false,
        remaining: 0,
        retryInMs: this.#globalRetryInMs(now),
        limit: this.#effectiveLimit,
        boundBy: 'global'
      };
    }

    if (!this.#clientMayProceed(clientId)) {
      return {
        granted: false,
        remaining: 0,
        retryInMs: this.#clientRetryInMs(clientId, now),
        limit: this.#effectiveLimit,
        boundBy: 'client'
      };
    }

    this.#record(clientId, now);
    if (this.#serverRemaining !== undefined && this.#serverRemaining > 0) {
      this.#serverRemaining -= 1;
    }

    return {
      granted: true,
      remaining: this.#availableFor(clientId, now),
      retryInMs: 0,
      limit: this.#effectiveLimit
    };
  }

  /**
   * Reports what `clientId` could spend without spending any of it.
   *
   * This is what `screen_companies` sizes its batch against. It has to be the
   * same arithmetic `acquire` uses, or the table promises rows the limiter
   * then refuses — which is the exact dishonesty ADR 8 exists to prevent.
   */
  peek(clientId: string, now: number): BudgetOutcome {
    this.#prune(now);

    if (now < this.#blockedUntil) {
      return {
        granted: false,
        remaining: 0,
        retryInMs: this.#blockedUntil - now,
        limit: this.#effectiveLimit,
        boundBy: 'penalty'
      };
    }

    const remaining = this.#availableFor(clientId, now);
    if (remaining > 0) {
      return { granted: true, remaining, retryInMs: 0, limit: this.#effectiveLimit };
    }

    const globalAvailable = this.#globalAvailable(now);
    const boundBy: BudgetBound = globalAvailable <= 0 ? 'global' : 'client';
    return {
      granted: false,
      remaining: 0,
      retryInMs:
        boundBy === 'global' ? this.#globalRetryInMs(now) : this.#clientRetryInMs(clientId, now),
      limit: this.#effectiveLimit,
      boundBy
    };
  }

  /** Records that the server rejected a request, holding all traffic until `resetAtMs`. */
  penalise(resetAtMs: number): void {
    this.#blockedUntil = Math.max(this.#blockedUntil, resetAtMs);
  }

  /** Folds a server rate-limit hint into local state. */
  observe(hint: ServerRateLimitHint): void {
    if (hint.remaining !== undefined) {
      this.#serverRemaining = hint.remaining;
      this.#serverRecordedAt = hint.recordedAtMs;
    }
    if (hint.resetAtMs !== undefined) {
      this.#serverResetAt = hint.resetAtMs;
    }
  }

  toState(): BudgetState {
    const clients: Record<string, number[]> = {};
    for (const [id, stamps] of this.#clients) clients[id] = [...stamps];
    return {
      timestamps: [...this.#timestamps],
      clients,
      blockedUntil: this.#blockedUntil,
      serverRemaining: this.#serverRemaining,
      serverResetAt: this.#serverResetAt,
      serverRecordedAt: this.#serverRecordedAt
    };
  }

  loadState(state: BudgetState): void {
    this.#timestamps = [...state.timestamps];
    this.#clients = new Map(Object.entries(state.clients).map(([id, s]) => [id, [...s]]));
    this.#blockedUntil = state.blockedUntil;
    this.#serverRemaining = state.serverRemaining;
    this.#serverResetAt = state.serverResetAt;
    this.#serverRecordedAt = state.serverRecordedAt;
  }

  // ---------------------------------------------------------------------

  #record(clientId: string, now: number): void {
    this.#timestamps.push(now);
    if (this.#clientReservation === undefined) return;

    const existing = this.#clients.get(clientId);
    if (existing === undefined) {
      this.#evictIfCrowded();
      this.#clients.set(clientId, [now]);
    } else {
      existing.push(now);
    }
  }

  /**
   * A client may always spend up to its reservation. Beyond that it may only
   * spend while the shared window is quiet.
   */
  #clientMayProceed(clientId: string): boolean {
    if (this.#clientReservation === undefined) return true;
    const used = this.#clients.get(clientId)?.length ?? 0;
    if (used < this.#clientReservation) return true;
    return this.#timestamps.length < this.#burstLimitFor(clientId);
  }

  /**
   * How far the global window may be spent down before `clientId` loses the
   * right to exceed its own reservation.
   *
   * Held back: one reservation for every *other* client active in this window,
   * plus `newcomerAllowance` more for clients that have not arrived yet. Which
   * means a lone caller on a quiet server keeps almost the entire budget — the
   * protection scales with the contention that actually exists, rather than
   * stranding a fixed fraction against a crowd that may never turn up.
   *
   * `#clients.size` is the count of clients with activity inside the window,
   * because `#prune` deletes the rest. That makes this O(1), which matters on
   * a path every single request goes through.
   */
  #burstLimitFor(clientId: string): number {
    const reservation = this.#clientReservation;
    if (reservation === undefined) return this.#effectiveLimit;

    const others = this.#clients.size - (this.#clients.has(clientId) ? 1 : 0);
    const heldBack = (others + this.#newcomerAllowance) * reservation;
    return Math.max(reservation, this.#effectiveLimit - heldBack);
  }

  /**
   * How many requests `clientId` could make right now, back to back.
   *
   * This has to be derived from the same rule `#clientMayProceed` applies, not
   * approximated alongside it. A request is allowed while EITHER the client is
   * under its reservation OR the window is under the burst limit, so a run of
   * `i` requests stops at the first `i` where both have run out:
   *
   *     i >= reservation - used     and     i >= burstLimit - globalUsed
   *
   * making the answer the larger of the two, capped by what the window has
   * left. Getting this wrong is not a rounding error: `screen_companies` sizes
   * its batch against this number, so an optimistic answer here is a table
   * that promises rows the limiter then refuses — precisely the silent
   * shortfall ADR 8 exists to prevent.
   */
  #availableFor(clientId: string, now: number): number {
    const globalAvailable = this.#globalAvailable(now);
    if (this.#clientReservation === undefined) return globalAvailable;

    const used = this.#clients.get(clientId)?.length ?? 0;
    const untilReservationSpent = Math.max(this.#clientReservation - used, 0);
    const untilBurstCloses = Math.max(this.#burstLimitFor(clientId) - this.#timestamps.length, 0);

    return Math.min(globalAvailable, Math.max(untilReservationSpent, untilBurstCloses));
  }

  #globalAvailable(now: number): number {
    const local = this.#effectiveLimit - this.#timestamps.length;
    if (this.#serverRemaining === undefined) return Math.max(local, 0);

    // The hint expires either at the reset time the server gave us or, when it
    // gave us none, one window after we recorded it. Without that second rule
    // a `remain: 0` header with no `reset` header would block this budget
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

  #globalRetryInMs(now: number): number {
    const oldest = this.#timestamps[0];
    if (oldest === undefined) {
      // Nothing local is holding us back, so the block is a server hint.
      if (this.#serverResetAt !== undefined) return Math.max(this.#serverResetAt - now, 1);
      return this.#windowMs;
    }
    return Math.max(oldest + this.#windowMs - now, 1);
  }

  #clientRetryInMs(clientId: string, now: number): number {
    const stamps = this.#clients.get(clientId);
    const oldest = stamps?.[0];
    if (oldest === undefined) return this.#globalRetryInMs(now);
    return Math.max(oldest + this.#windowMs - now, 1);
  }

  #prune(now: number): void {
    const cutoff = now - this.#windowMs;
    while (this.#timestamps.length > 0 && (this.#timestamps[0] as number) <= cutoff) {
      this.#timestamps.shift();
    }
    for (const [id, stamps] of this.#clients) {
      while (stamps.length > 0 && (stamps[0] as number) <= cutoff) stamps.shift();
      // Drop clients with nothing in the window, or an open endpoint would
      // accumulate an entry per caller for the lifetime of the process.
      if (stamps.length === 0) this.#clients.delete(id);
    }
  }

  /**
   * Last-resort bound on tracked clients.
   *
   * `#prune` already removes anyone idle for a window, so this only fires
   * against a burst of distinct identities inside a single window — which is
   * to say, against abuse. Evicting the least recently active is the least bad
   * option: it costs that client its reservation, not the budget's integrity,
   * because the global window is tracked separately and stays correct.
   */
  #evictIfCrowded(): void {
    if (this.#clients.size < this.#maxTrackedClients) return;
    let oldestId: string | undefined;
    let oldestStamp = Number.POSITIVE_INFINITY;
    for (const [id, stamps] of this.#clients) {
      const last = stamps[stamps.length - 1] ?? 0;
      if (last < oldestStamp) {
        oldestStamp = last;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) this.#clients.delete(oldestId);
  }
}
