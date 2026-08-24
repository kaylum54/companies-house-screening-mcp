import type { BudgetOutcome, ServerRateLimitHint, SlidingWindowBudgetOptions } from '../http/budget.js';
import type { BudgetStore } from '../http/budget-store.js';
import type { DurableObjectNamespace } from './types.js';

/**
 * A `BudgetStore` that defers to a Durable Object.
 *
 * The name given to `idFromName` is what decides who shares a window, and it
 * is the credential — not the session, not the caller. Every request spending
 * the pooled key routes to one object; a caller who brought their own key
 * routes to a different one. That mirrors how Companies House meters, which is
 * the only partition that can be correct. See ADR 13.
 */

export interface DurableObjectBudgetStoreOptions {
  namespace: DurableObjectNamespace;
  /**
   * Identifies the credential whose window this is — a fingerprint, never the
   * key itself. Durable Object names are not secret: they appear in platform
   * metadata and logs, so putting an API key in one would leak it.
   */
  budgetName: string;
  /**
   * Shape of the window this store addresses.
   *
   * Sent with every operation rather than configured on the object, because
   * one Durable Object class backs both the pooled window (fair shares on) and
   * a caller's private window (fair shares off, since nobody else can reach
   * it). See the note in `budget-do.ts`.
   */
  budgetOptions: SlidingWindowBudgetOptions;
  /**
   * What to do when the Durable Object cannot be reached.
   *
   * Defaults to failing closed: an unreachable limiter means an unknown
   * window, and guessing optimistically is how a rate limit gets blown through
   * during exactly the incident that made it unreachable.
   */
  failOpen?: boolean;
}

/** Only the host matters; Durable Object stubs ignore it. */
const STUB_URL = 'https://budget.invalid/';

export class DurableObjectBudgetStore implements BudgetStore {
  readonly #namespace: DurableObjectNamespace;
  readonly #budgetName: string;
  readonly #failOpen: boolean;
  readonly #budgetOptions: SlidingWindowBudgetOptions;

  constructor(options: DurableObjectBudgetStoreOptions) {
    this.#namespace = options.namespace;
    this.#budgetName = options.budgetName;
    this.#budgetOptions = options.budgetOptions;
    this.#failOpen = options.failOpen ?? false;
  }

  async acquire(clientId: string, now: number): Promise<BudgetOutcome> {
    return this.#call({ op: 'acquire', clientId, now });
  }

  async peek(clientId: string, now: number): Promise<BudgetOutcome> {
    return this.#call({ op: 'peek', clientId, now });
  }

  async penalise(resetAtMs: number): Promise<void> {
    await this.#send({ op: 'penalise', resetAtMs });
  }

  async observe(hint: ServerRateLimitHint): Promise<void> {
    await this.#send({ op: 'observe', hint });
  }

  async #call(operation: Record<string, unknown>): Promise<BudgetOutcome> {
    try {
      const response = await this.#send(operation);
      if (response === undefined) return this.#unavailable();
      return (await response.json()) as BudgetOutcome;
    } catch {
      return this.#unavailable();
    }
  }

  async #send(operation: Record<string, unknown>): Promise<Response | undefined> {
    const stub = this.#namespace.get(this.#namespace.idFromName(this.#budgetName));
    const response = await stub.fetch(STUB_URL, {
      method: 'POST',
      body: JSON.stringify({ ...operation, options: this.#budgetOptions })
    });
    return response.ok ? response : undefined;
  }

  /**
   * What to report when the window cannot be consulted.
   *
   * Failing closed costs availability during a platform incident. Failing open
   * costs the API key, because every isolate would decide independently that it
   * had a full allowance — the precise failure this whole design removed. The
   * retry hint is deliberately short: this is a transient fault, not an
   * exhausted budget, and the caller should come back promptly.
   */
  #unavailable(): BudgetOutcome {
    if (this.#failOpen) {
      return { granted: true, remaining: 1, retryInMs: 0, limit: 1 };
    }
    return {
      granted: false,
      remaining: 0,
      retryInMs: 1_000,
      limit: 0,
      boundBy: 'global'
    };
  }
}
