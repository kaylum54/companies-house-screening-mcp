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
  /**
   * What the *whole window* has left, before fair shares are applied.
   *
   * Different from `remaining`, and the difference is the point. `remaining`
   * is one caller's share, which is bounded below by their reservation — an
   * unseen client is guaranteed one, so peeking as one can never report less
   * than a reservation until the window itself is almost gone. Anything
   * asking "is this deployment near its ceiling" has to read this instead, or
   * it is watching a number that structurally cannot cross the threshold it
   * is being compared against. Used by the scheduled health check.
   */
  globalRemaining: number;
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
  // Finite, not merely numeric. A non-finite `blockedUntil` latches forever
  // through `Math.max` and silently disables 429 penalties for that
  // credential, and non-finite timestamps never prune.
  const isFinite = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value);

  if (!Array.isArray(candidate['timestamps'])) return false;
  if (!candidate['timestamps'].every(isFinite)) return false;
  if (!isFinite(candidate['blockedUntil'])) return false;

  const clients = candidate['clients'];
  if (typeof clients !== 'object' || clients === null || Array.isArray(clients)) return false;

  // The server-hint fields are restored too, and a non-numeric one is worse
  // than a crash: `#globalAvailable` returns NaN, which passes the `<= 0`
  // guard and reaches `screen_companies` as `slice(0, NaN)` — every company
  // reported unaffordable against a budget that was never spent.
  const numberOrAbsent = (value: unknown): boolean => value === undefined || isFinite(value);

  if (
    !numberOrAbsent(candidate['serverRemaining']) ||
    !numberOrAbsent(candidate['serverResetAt']) ||
    !numberOrAbsent(candidate['serverRecordedAt'])
  ) {
    return false;
  }

  // The values matter as much as the container: `loadState` spreads each one
  // and `#prune` calls `.shift()` on it, so a non-array here throws inside
  // `blockConcurrencyWhile` — which is the very failure this guard exists to
  // stop, arriving one level deeper than the first version checked.
  return Object.values(clients as Record<string, unknown>).every(
    (stamps) => Array.isArray(stamps) && stamps.every(isFinite)
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
        // Reported even while blocked: a 429 penalty says nothing about how
        // full the window is, and a health check must not read a hold as an
        // exhausted budget.
        globalRemaining: this.#globalAvailable(now),
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
        globalRemaining: 0,
        boundBy: 'global'
      };
    }

    if (!this.#clientMayProceed(clientId)) {
      return {
        granted: false,
        remaining: 0,
        retryInMs: this.#clientRetryInMs(clientId, now),
        limit: this.#effectiveLimit,
        globalRemaining: globalAvailable,
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
      limit: this.#effectiveLimit,
      globalRemaining: this.#globalAvailable(now)
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
        globalRemaining: this.#globalAvailable(now),
        boundBy: 'penalty'
      };
    }

    const remaining = this.#availableFor(clientId, now);
    if (remaining > 0) {
      return {
        granted: true,
        remaining,
        retryInMs: 0,
        limit: this.#effectiveLimit,
        globalRemaining: this.#globalAvailable(now)
      };
    }

    const globalAvailable = this.#globalAvailable(now);
    const boundBy: BudgetBound = globalAvailable <= 0 ? 'global' : 'client';
    return {
      granted: false,
      remaining: 0,
      retryInMs:
        boundBy === 'global' ? this.#globalRetryInMs(now) : this.#clientRetryInMs(clientId, now),
      limit: this.#effectiveLimit,
      globalRemaining: globalAvailable,
      boundBy
    };
  }

  /** Records that the server rejected a request, holding all traffic until `resetAtMs`. */
  penalise(resetAtMs: number): void {
    this.#blockedUntil = Math.max(this.#blockedUntil, resetAtMs);
  }

  /** Folds a server rate-limit hint into local state. */
  /**
   * Folds a server rate-limit hint into the window.
   *
   * A hint replaces the server's view rather than patching it, because the two
   * headers arrive independently and pairing a new one with a leftover old one
   * is wrong in both directions:
   *
   * - A fresh count with a stale reset is expired the moment it is read, so
   *   the server's warning that we are running out gets discarded and the
   *   limiter runs to its own ceiling straight into the 429s these headers
   *   exist to help us avoid.
   * - A fresh reset with a stale `remaining: 0` extends a block that should
   *   have ended by a whole extra window, refusing a budget that is fine.
   *
   * So each field is taken only from the hint in hand.
   */
  observe(hint: ServerRateLimitHint): void {
    this.#serverRemaining = hint.remaining;
    this.#serverResetAt = hint.resetAtMs;
    this.#serverRecordedAt = hint.remaining === undefined ? undefined : hint.recordedAtMs;
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

  /**
   * When the caller may next expect a slot.
   *
   * Both constraints have to be consulted, not just whichever is convenient.
   * A server `remain: 0` hint can block a window that still has local room, and
   * quoting the local oldest-entry expiry then reports a time that can be
   * minutes early — after which the caller retries, is refused again, and pays
   * a round trip for it. `screen_companies` prints this number verbatim, so an
   * optimistic one is a promise to the user that the register will not keep.
   */
  #globalRetryInMs(now: number): number {
    // Each constraint is quoted only while it is actually the one blocking.
    // The local window's oldest entry expiring says nothing about when a slot
    // frees up if there are hundreds of local slots already free — the block
    // is then entirely the server's, and folding the local expiry in reported
    // a whole window for what might be a five-second hold.
    const localExhausted = this.#effectiveLimit - this.#timestamps.length <= 0;
    const oldest = this.#timestamps[0];
    const localMs =
      localExhausted && oldest !== undefined
        ? Math.max(oldest + this.#windowMs - now, 1)
        : undefined;

    // Only meaningful while the hint is actually the thing blocking us. When
    // it carries no reset time the block still ends — one window after it was
    // recorded, per the expiry rule in `#globalAvailable`. Quoting the local
    // expiry instead reported seconds for a block that lasts minutes, and
    // `RateLimiter.acquire` then retried into a guaranteed refusal.
    let serverMs: number | undefined;
    if (this.#serverRemaining !== undefined && this.#serverRemaining <= 0) {
      if (this.#serverResetAt !== undefined) {
        serverMs = Math.max(this.#serverResetAt - now, 1);
      } else if (this.#serverRecordedAt !== undefined) {
        serverMs = Math.max(this.#serverRecordedAt + this.#windowMs - now, 1);
      }
    }

    if (localMs === undefined && serverMs === undefined) return this.#windowMs;
    if (localMs === undefined) return serverMs as number;
    if (serverMs === undefined) return localMs;
    return Math.max(localMs, serverMs);
  }

  /**
   * When a client refused by its own share may next proceed.
   *
   * The oldest timestamp expiring frees exactly one slot, and a client held to
   * its reservation is usually many slots over — so quoting it reports a wait
   * that is comfortably too short, and `screen_companies` prints it in every
   * skipped row. The admission rule says such a client proceeds once EITHER
   * its own usage drops below its reservation OR the window drops below its
   * burst limit, so the honest answer is whichever of those happens first, and
   * each is the expiry of a specific timestamp rather than the earliest one.
   */
  #clientRetryInMs(clientId: string, now: number): number {
    const reservation = this.#clientReservation;
    const stamps = this.#clients.get(clientId);
    if (reservation === undefined || stamps === undefined || stamps.length === 0) {
      return this.#globalRetryInMs(now);
    }

    const expiryOf = (list: number[], index: number): number | undefined => {
      const stamp = list[index];
      return stamp === undefined ? undefined : Math.max(stamp + this.#windowMs - now, 1);
    };

    // Enough of this client's own requests must age out to drop it back under
    // its reservation.
    const ownWait = expiryOf(stamps, stamps.length - reservation);

    // ...or enough of anyone's must age out to reopen bursting.
    const burstLimit = this.#burstLimitFor(clientId);
    const globalWait = expiryOf(this.#timestamps, this.#timestamps.length - burstLimit);

    const candidates = [ownWait, globalWait].filter(
      (value): value is number => value !== undefined
    );
    if (candidates.length === 0) return this.#globalRetryInMs(now);
    return Math.min(...candidates);
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
