/**
 * Writing a finished request to Workers Analytics Engine.
 *
 * One data point per invocation, never one per upstream call. That is not an
 * optimisation: the platform accepts at most 250 `writeDataPoint` calls per
 * invocation, and a fifty-company `screen_companies` run makes roughly 150
 * upstream requests — 200 with officers included. Emitting per call would sit
 * against that ceiling and start silently dropping the tail of exactly the
 * runs an operator most wants to see. Accumulating in `RequestMetrics` and
 * flushing once costs one call regardless of how big the batch was.
 *
 * **Columns are positional and permanent.** Analytics Engine stores blobs and
 * doubles as `blob1..blob20` and `double1..double20`; the names below exist
 * only in this file. Inserting a column in the middle does not migrate old
 * rows — it reinterprets them, so every query and every chart over the
 * previous three months silently starts reading the wrong field. Append at
 * the end, never reorder, and never repurpose a retired slot.
 */

import type { MetricsSink, RequestSnapshot } from '../telemetry/metrics.js';
import type { AnalyticsEngineDataset } from './types.js';

/**
 * The schema, as a comment that cannot drift far from the code below.
 *
 *   index1  tool          also the sampling key, so a flood of one tool
 *                         cannot hide the others
 *   blob1   outcome       ok | error | refused
 *   blob2   errorCode     '' unless outcome is error
 *   blob3   refusalCause  none | client | global | penalty | unavailable
 *   blob4   version       the deployed version, for before/after comparisons
 *
 *   double1  upstreamRequests   what this cost the key
 *   double2  cacheHits
 *   double3  cacheMisses
 *   double4  upstreamRetries
 *   double5  upstreamThrottled  429s from Companies House
 *   double6  staleServed
 *   double7  budgetRemaining    -1 when the budget was never consulted
 *   double8  budgetLimit        -1 likewise
 *   double9  durationMs
 *   double10 ownKey             1 when the caller brought their own key
 *
 * Nothing here identifies a caller or says which company was looked up. See
 * ADR 16 for why that is a deliberate limit rather than an oversight.
 */
export interface DataPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

export function toDataPoint(snapshot: RequestSnapshot, version: string): DataPoint {
  return {
    // One index, which is the platform maximum. `tool` is the field worth
    // grouping by and the one worth sampling by.
    indexes: [snapshot.tool],
    blobs: [snapshot.outcome, snapshot.errorCode, snapshot.refusalCause, version],
    doubles: [
      snapshot.upstreamRequests,
      snapshot.cacheHits,
      snapshot.cacheMisses,
      snapshot.upstreamRetries,
      snapshot.upstreamThrottled,
      snapshot.staleServed,
      snapshot.budgetRemaining,
      snapshot.budgetLimit,
      snapshot.durationMs,
      snapshot.ownKey ? 1 : 0
    ]
  };
}

export interface AnalyticsSinkOptions {
  dataset: AnalyticsEngineDataset;
  /** Stamped on every row, so a regression can be attributed to a deploy. */
  version: string;
  /** Told when a write throws. Defaults to silence. */
  onError?: (error: unknown) => void;
}

/**
 * Writes one row per request, and never lets that failure become the caller's.
 *
 * The try/catch is not defensive dressing. This runs in the `finally` of a
 * request that has already produced an answer, so a throw here would replace a
 * good response with a 500 — measurement taking down the thing it measures,
 * which is the worst possible trade and a well-worn way to cause an outage.
 */
export class AnalyticsEngineSink implements MetricsSink {
  readonly #dataset: AnalyticsEngineDataset;
  readonly #version: string;
  readonly #onError: (error: unknown) => void;

  constructor(options: AnalyticsSinkOptions) {
    this.#dataset = options.dataset;
    this.#version = options.version;
    this.#onError = options.onError ?? (() => {});
  }

  write(snapshot: RequestSnapshot): void {
    try {
      this.#dataset.writeDataPoint(toDataPoint(snapshot, this.#version));
    } catch (error) {
      this.#onError(error);
    }
  }
}
