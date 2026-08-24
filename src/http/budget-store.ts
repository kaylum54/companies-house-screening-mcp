import type { BudgetOutcome, ServerRateLimitHint, SlidingWindowBudgetOptions } from './budget.js';
import { SlidingWindowBudget } from './budget.js';

/**
 * Where a budget's window actually lives.
 *
 * One store instance governs one credential. That is the unit that matters,
 * because Companies House meters per key: two sessions sharing this server's
 * key share a store and therefore share a window, while a session that brought
 * its own key gets a store of its own and cannot be starved by, or starve,
 * anybody else. See ADR 13.
 *
 * Every method is async because the authoritative implementation is not in
 * this process. On Cloudflare the store is a stub in front of a Durable
 * Object, and "check the window and take a slot" is a round trip. Making that
 * shape the interface — rather than bolting async onto a synchronous limiter
 * later — is what keeps the in-memory and distributed answers identical.
 */
export interface BudgetStore {
  /** Waits for nothing; either grants a slot now or explains why not. */
  acquire(clientId: string, now: number): Promise<BudgetOutcome>;
  /** Reports what could be spent, spending none of it. */
  peek(clientId: string, now: number): Promise<BudgetOutcome>;
  /** Holds all traffic on this budget until `resetAtMs`. */
  penalise(resetAtMs: number): Promise<void>;
  /** Folds a server rate-limit hint into the window. */
  observe(hint: ServerRateLimitHint): Promise<void>;
}

/**
 * In-process store. Correct for exactly one process per credential — stdio,
 * or a single always-on HTTP instance.
 *
 * Acquisitions are serialised through a promise chain. Without it, ten
 * concurrent callers all read a budget of one, all decide they may proceed,
 * and the limiter has failed at precisely the moment it mattered. A Durable
 * Object gets this property from the platform; here it has to be built.
 */
export class MemoryBudgetStore implements BudgetStore {
  readonly #budget: SlidingWindowBudget;
  #chain: Promise<void> = Promise.resolve();

  constructor(options: SlidingWindowBudgetOptions = {}) {
    this.#budget = new SlidingWindowBudget(options);
  }

  get effectiveLimit(): number {
    return this.#budget.effectiveLimit;
  }

  get fairShareEnabled(): boolean {
    return this.#budget.fairShareEnabled;
  }

  async acquire(clientId: string, now: number): Promise<BudgetOutcome> {
    return this.#serialise(() => this.#budget.acquire(clientId, now));
  }

  async peek(clientId: string, now: number): Promise<BudgetOutcome> {
    return this.#serialise(() => this.#budget.peek(clientId, now));
  }

  async penalise(resetAtMs: number): Promise<void> {
    await this.#serialise(() => this.#budget.penalise(resetAtMs));
  }

  async observe(hint: ServerRateLimitHint): Promise<void> {
    await this.#serialise(() => this.#budget.observe(hint));
  }

  #serialise<T>(work: () => T): Promise<T> {
    const run = this.#chain.then(work);
    // Keep the chain alive even if one operation rejects.
    this.#chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
