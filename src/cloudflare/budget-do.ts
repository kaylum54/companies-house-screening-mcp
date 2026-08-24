import type { BudgetOutcome, BudgetState, ServerRateLimitHint } from '../http/budget.js';
import { SlidingWindowBudget } from '../http/budget.js';
import type { DurableObjectState } from './types.js';

/**
 * The rate-limit window, as a Durable Object.
 *
 * This is the reason Cloudflare was worth targeting. A Durable Object is
 * single-threaded and globally unique for a given name, so every request for
 * this key — from any isolate, in any datacentre — is serialised through one
 * instance. "Check the window and take a slot" is therefore genuinely atomic,
 * rather than atomic-provided-nobody-scaled-the-service-out.
 *
 * That is a stronger guarantee than a single Node process gives, and it is the
 * difference between a limiter that is correct and one that is correct until
 * traffic arrives. The alternative on other platforms is pinning the service
 * to one instance and hoping nobody changes it. See ADR 13.
 *
 * The window arithmetic itself lives in `SlidingWindowBudget` and is shared
 * verbatim with the in-memory store. Nothing about the algorithm is
 * reimplemented here; this class only supplies the concurrency guarantee and
 * the persistence.
 */

const STATE_KEY = 'budget';

export interface BudgetDurableObjectOptions {
  limit: number;
  windowMs: number;
  safetyMargin: number;
  clientReservation?: number | undefined;
  newcomerAllowance?: number;
  maxTrackedClients?: number;
}

/**
 * Every operation carries the shape of the window it is addressing.
 *
 * The alternative — configuring the object at construction — cannot work,
 * because one Durable Object class backs two kinds of window: the pooled key's,
 * which enforces fair shares, and a caller's own, which must not. A constructor
 * reading the environment has no way to tell which one it has become, and
 * quietly applied fair sharing to private budgets, costing their owners a slice
 * of an allowance nobody else could reach.
 *
 * Options are sent rather than stored because they are derived from
 * configuration the caller already holds, and a given object name is always
 * addressed with the same ones.
 */
type Operation =
  | { op: 'acquire'; clientId: string; now: number; options: BudgetDurableObjectOptions }
  | { op: 'peek'; clientId: string; now: number; options: BudgetDurableObjectOptions }
  | { op: 'penalise'; resetAtMs: number; options: BudgetDurableObjectOptions }
  | { op: 'observe'; hint: ServerRateLimitHint; options: BudgetDurableObjectOptions };

/**
 * Base class carrying the behaviour. The deployed Durable Object subclasses
 * this to supply its configuration from the Worker's environment, which keeps
 * the logic testable without a Workers runtime.
 */
export class BudgetDurableObject {
  readonly #state: DurableObjectState;
  #budget: SlidingWindowBudget | undefined;
  #restored: Promise<void> | undefined;

  constructor(state: DurableObjectState) {
    this.#state = state;
  }

  /**
   * Builds the window on first contact and restores anything persisted.
   *
   * Restoring inside `blockConcurrencyWhile` guarantees no request is served
   * against an empty window that should not have been empty — otherwise every
   * eviction by the platform would hand out a fresh allowance.
   */
  async #ready(options: BudgetDurableObjectOptions): Promise<SlidingWindowBudget> {
    if (this.#budget === undefined) {
      const budget = new SlidingWindowBudget(options);
      this.#budget = budget;
      this.#restored = this.#state.blockConcurrencyWhile(async () => {
        const stored = await this.#state.storage.get<BudgetState>(STATE_KEY);
        if (stored !== undefined) budget.loadState(stored);
      });
    }
    await this.#restored;
    return this.#budget;
  }

  async fetch(request: Request): Promise<Response> {
    let operation: Operation;
    try {
      operation = (await request.json()) as Operation;
    } catch {
      return json({ error: 'malformed operation' }, 400);
    }

    if (operation.options === undefined || operation.options === null) {
      return json({ error: 'operation is missing its budget options' }, 400);
    }

    const budget = await this.#ready(operation.options);

    switch (operation.op) {
      case 'acquire': {
        const outcome = budget.acquire(operation.clientId, operation.now);
        // Only a grant changes the window, so only a grant needs persisting.
        if (outcome.granted) await this.#persist(budget);
        return json(outcome);
      }
      case 'peek':
        return json(budget.peek(operation.clientId, operation.now));
      case 'penalise':
        budget.penalise(operation.resetAtMs);
        await this.#persist(budget);
        return json({ ok: true });
      case 'observe':
        budget.observe(operation.hint);
        await this.#persist(budget);
        return json({ ok: true });
      default:
        return json({ error: 'unknown operation' }, 400);
    }
  }

  async #persist(budget: SlidingWindowBudget): Promise<void> {
    await this.#state.storage.put(STATE_KEY, budget.toState());
  }
}

function json(body: BudgetOutcome | Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
