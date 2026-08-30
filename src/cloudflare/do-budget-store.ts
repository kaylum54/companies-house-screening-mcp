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
}

/** Only the host matters; Durable Object stubs ignore it. */
const STUB_URL = 'https://budget.invalid/';

export class DurableObjectBudgetStore implements BudgetStore {
  readonly #namespace: DurableObjectNamespace;
  readonly #budgetName: string;
  readonly #budgetOptions: SlidingWindowBudgetOptions;

  constructor(options: DurableObjectBudgetStoreOptions) {
    this.#namespace = options.namespace;
    this.#budgetName = options.budgetName;
    this.#budgetOptions = options.budgetOptions;
  }

  async acquire(clientId: string, now: number): Promise<BudgetOutcome> {
    return this.#call({ op: 'acquire', clientId, now });
  }

  async peek(clientId: string, now: number): Promise<BudgetOutcome> {
    return this.#call({ op: 'peek', clientId, now });
  }

  /**
   * Both of these are best-effort corrections applied *after* a successful
   * Companies House response, so a failure here must stay here. `observe` runs
   * on every single response; letting it throw would turn a Durable Object
   * hiccup into a failed request that the upstream had already answered.
   */
  async penalise(resetAtMs: number): Promise<void> {
    try {
      await this.#send({ op: 'penalise', resetAtMs });
    } catch {
      // The window keeps its own count; a missed penalty is a smaller problem
      // than a failed request that already succeeded.
    }
  }

  async observe(hint: ServerRateLimitHint): Promise<void> {
    try {
      await this.#send({ op: 'observe', hint });
    } catch {
      // As above. The server hint is a correction, never the source of truth.
    }
  }

  async #call(operation: Record<string, unknown>): Promise<BudgetOutcome> {
    try {
      const response = await this.#send(operation);
      if (response === undefined) return this.#unavailable();
      const parsed: unknown = await response.json();
      // Validated rather than cast. This crosses a process boundary, and every
      // consumer downstream was left guarding the same values individually:
      // `sane()` in the alerting, the refusal-cause allowlist in the metrics,
      // and nothing at all in the retry loop — where a non-finite `retryInMs`
      // makes `now + retryInMs > deadline` false, `Math.max(NaN, 1)` NaN and
      // `sleep(NaN)` immediate, turning a refusal into sixty-four round trips
      // to the coordinator as fast as they will go.
      if (!isBudgetOutcome(parsed)) return this.#unavailable();
      return parsed;
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
   *
   * There used to be a `failOpen` option here. Nothing set it, the ADR argues
   * against it, and the placeholder it returned carried no `boundBy` — so the
   * fabricated "1 of 1" was charted as a real reading, drawing a coordinator
   * outage as a window 100% consumed. An unreachable switch that would defeat
   * the system's central guarantee if anybody ever found it is worse than no
   * switch.
   */
  #unavailable(): BudgetOutcome {
    return {
      granted: false,
      remaining: 0,
      retryInMs: 1_000,
      limit: 0,
      // Not a reading of an empty window: nothing was read at all. `boundBy`
      // is what distinguishes the two, and anything charting this figure has
      // to check it — see the heartbeat in worker.ts, which records nothing
      // rather than plotting a coordinator outage as a budget collapse.
      globalRemaining: 0,
      boundBy: 'unavailable'
    };
  }
}

/**
 * The shape the Durable Object promises, checked rather than assumed.
 *
 * A reading whose numbers are not numbers is not a reading; treating it as one
 * is worse than treating the coordinator as unreachable, because every caller
 * downstream then makes its own arithmetic out of `NaN`.
 */
function isBudgetOutcome(value: unknown): value is BudgetOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['granted'] !== 'boolean') return false;
  for (const field of ['remaining', 'retryInMs', 'limit', 'globalRemaining']) {
    if (typeof candidate[field] !== 'number' || !Number.isFinite(candidate[field])) return false;
  }
  const bound = candidate['boundBy'];
  return (
    bound === undefined ||
    bound === 'client' ||
    bound === 'global' ||
    bound === 'penalty' ||
    bound === 'unavailable'
  );
}
