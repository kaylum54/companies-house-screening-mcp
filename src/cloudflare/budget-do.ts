import type { BudgetOutcome, BudgetState, ServerRateLimitHint } from '../http/budget.js';
import { isBudgetState, SlidingWindowBudget } from '../http/budget.js';
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
  /**
   * The in-flight first restore.
   *
   * Guarding on `#budget` alone is not enough: two concurrent first requests
   * would each build and restore a window, the later assignment would win, and
   * the slot granted against the discarded one would vanish from the persisted
   * count. Memoizing the promise means the second caller waits for the first
   * rather than racing it.
   */
  #initialising: Promise<SlidingWindowBudget> | undefined;

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
    const existing = this.#budget;
    if (existing !== undefined) return existing;

    const inFlight = this.#initialising;
    if (inFlight !== undefined) return inFlight;

    const attempt = (async (): Promise<SlidingWindowBudget> => {
      const budget = new SlidingWindowBudget(options);
      await this.#state.blockConcurrencyWhile(async () => {
        const stored = await this.#state.storage.get<unknown>(STATE_KEY);
        // Written by a possibly older shape of this code, and it outlives any
        // single deploy. An unreadable value is dropped rather than loaded:
        // starting from an empty window loses this window's history, whereas
        // throwing here would refuse the credential permanently.
        if (isBudgetState(stored)) budget.loadState(stored);
      });
      this.#budget = budget;
      return budget;
    })();

    // Cleared on failure, never cached: storage refusing once must not leave a
    // rejected promise that fails every later request closed. Caching the
    // half-built empty budget would be worse still — it would hand out a fresh
    // allowance for a window we simply could not read.
    this.#initialising = attempt;
    try {
      return await attempt;
    } catch (error) {
      this.#initialising = undefined;
      throw error;
    }
  }

  async fetch(request: Request): Promise<Response> {
    let operation: Operation;
    try {
      operation = (await request.json()) as Operation;
    } catch {
      return json({ error: 'malformed operation' }, 400);
    }

    // `JSON.parse` happily yields `null`, a number or a string. Reading
    // `.options` off any of those throws outside both try blocks, and the
    // store reads the resulting failure as an unreachable window — failing the
    // caller closed over what should have been a plain 400.
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
      return json({ error: 'operation must be an object' }, 400);
    }

    if (operation.options === undefined || operation.options === null) {
      return json({ error: 'operation is missing its budget options' }, 400);
    }

    let budget: SlidingWindowBudget;
    try {
      budget = await this.#ready(operation.options);
    } catch {
      // The store treats a non-2xx as unreachable and fails closed, which is
      // the right answer for a window we cannot read.
      return json({ error: 'budget storage unavailable' }, 503);
    }

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
        // Deliberately not persisted. This runs after every single upstream
        // response, and writing the whole window each time would double the
        // storage traffic on the request path — roughly 300 writes for one
        // fifty-company screen — to durably record a correction this code
        // itself treats as never being the source of truth. Losing it to an
        // eviction costs nothing the local count does not already know.
        budget.observe(operation.hint);
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
