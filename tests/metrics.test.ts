import { describe, expect, it } from 'vitest';

import { AnalyticsEngineSink, toDataPoint } from '../src/cloudflare/analytics-metrics.js';
import { createRequestMetrics, label, silentMetrics } from '../src/telemetry/metrics.js';
import type { RequestSnapshot } from '../src/telemetry/metrics.js';

/**
 * The measurement layer, and the limits on it.
 *
 * Two things are being established here. The first is arithmetic: that the
 * counters count. The second matters more — that this layer *cannot* carry a
 * caller's identity or the companies they looked up out of the request, no
 * matter what a future change hands it. Analytics data is retained for three
 * months and queried by whoever runs the deployment, so a leak here is not a
 * log line somebody might rotate away.
 *
 * These run under Node deliberately. Miniflare's Analytics Engine binding is
 * `writeDataPoint(_event) {}` — a no-op stub — so a test inside `workerd`
 * could prove a write was accepted and never what was in it. Keeping the
 * shaping in the portable core is what makes it assertable at all.
 */

describe('RequestMetrics counts what a request did', () => {
  it('starts at nothing and reports a clean request as ok', () => {
    const snapshot = createRequestMetrics().snapshot(12);

    expect(snapshot).toMatchObject({
      tool: 'unknown',
      outcome: 'ok',
      errorCode: '',
      refusalCause: 'none',
      upstreamRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      durationMs: 12
    });
  });

  it('accumulates the counters a cost question comes back to', () => {
    const metrics = createRequestMetrics();
    metrics.tool('company_snapshot');
    for (let i = 0; i < 4; i += 1) metrics.upstreamRequest();
    metrics.cacheHit();
    metrics.cacheHit();
    metrics.cacheMiss();
    metrics.upstreamRetry();
    metrics.upstreamThrottled();
    metrics.staleServed();
    metrics.budget(498, 570);

    expect(metrics.snapshot(340)).toMatchObject({
      tool: 'company_snapshot',
      upstreamRequests: 4,
      cacheHits: 2,
      cacheMisses: 1,
      upstreamRetries: 1,
      upstreamThrottled: 1,
      staleServed: 1,
      budgetRemaining: 498,
      budgetLimit: 570
    });
  });

  it('reports the budget as it stood at the end, not when first sampled', () => {
    // A request makes several acquisitions; the figure worth keeping is how
    // close to the edge it finished, which is the last one.
    const metrics = createRequestMetrics();
    metrics.budget(500, 570);
    metrics.budget(499, 570);
    metrics.budget(496, 570);

    expect(metrics.snapshot(1).budgetRemaining).toBe(496);
  });

  it('distinguishes a refusal from an error, and prefers the refusal', () => {
    // These are different operational problems. A refusal says the limiter
    // turned somebody away and why; an error says something broke. Collapsing
    // them into one column is how "we are at capacity" gets mistaken for
    // "we are broken" on a dashboard.
    const metrics = createRequestMetrics();
    metrics.failed('RATE_LIMITED');
    metrics.refused('client');

    expect(metrics.snapshot(5)).toMatchObject({
      outcome: 'refused',
      refusalCause: 'client',
      errorCode: 'rate_limited'
    });
  });

  it('does not let a later error overwrite a refusal already recorded', () => {
    const metrics = createRequestMetrics();
    metrics.refused('unavailable');
    metrics.failed('UPSTREAM_UNAVAILABLE');

    expect(metrics.snapshot(5).outcome).toBe('refused');
    expect(metrics.snapshot(5).refusalCause).toBe('unavailable');
  });

  it('clamps a counter that has run away rather than emitting it', () => {
    // An analytics column is a double. One poisoned reading skews every
    // average computed over the dataset afterwards, and nothing distinguishes
    // it from a real one after the fact.
    const metrics = createRequestMetrics();
    metrics.budget(Number.POSITIVE_INFINITY, Number.NaN);

    const snapshot = metrics.snapshot(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(snapshot.budgetRemaining)).toBe(true);
    expect(Number.isFinite(snapshot.budgetLimit)).toBe(true);
    expect(Number.isFinite(snapshot.durationMs)).toBe(true);
    expect(snapshot.budgetLimit).toBe(0);
  });

  it('never emits a negative count', () => {
    const metrics = createRequestMetrics();
    metrics.budget(-40, -1);
    expect(metrics.snapshot(-5).budgetRemaining).toBe(0);
    expect(metrics.snapshot(-5).durationMs).toBe(0);
  });

  it('records that a caller brought their own key, without recording the key', () => {
    const metrics = createRequestMetrics();
    metrics.ownKey();
    const snapshot = metrics.snapshot(1);

    expect(snapshot.ownKey).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('key');
  });
});

describe('labels cannot carry information out', () => {
  // The two call sites pass a tool name and an error code, both from closed
  // sets in this codebase. This is the guarantee that holds when a later
  // change is careless: whatever reaches a label, only `[a-z0-9_]` survives.
  it.each([
    ['GREGGS PLC', 'greggsplc'],
    ['?q=royal+mail&items_per_page=20', 'qroyalmailitems_per_page20'],
    ['user@example.com', 'userexamplecom'],
    ['ab\ncd', 'abcd']
  ])('strips %s down to word characters', (input, expected) => {
    expect(label(input)).toBe(expected);
  });

  it('bounds the length, so nothing long survives whole', () => {
    expect(label('a'.repeat(500))).toHaveLength(48);
  });

  it('truncates a URL before the identifier on the end of it survives', () => {
    // The two defences compound. Stripping punctuation makes a URL
    // unusable; the 48-character bound then cuts it off part-way through the
    // company number, so not even the digits come out intact.
    const url = 'https://api.company-information.service.gov.uk/company/04138203';
    expect(label(url)).toBe('httpsapicompanyinformationservicegovukcompany041');
    expect(label(url)).not.toContain('04138203');
  });

  it('ignores an empty label rather than recording a blank tool', () => {
    const metrics = createRequestMetrics();
    metrics.tool('!!!');
    expect(metrics.snapshot(1).tool).toBe('unknown');
  });

  it('sanitises whatever reaches the recorder', () => {
    const metrics = createRequestMetrics();
    metrics.tool('/company/04138203');
    metrics.failed('Bearer abc.def');

    const snapshot = metrics.snapshot(1);
    expect(snapshot.tool).toBe('company04138203');
    expect(snapshot.errorCode).toBe('bearerabcdef');
    // Mangled, and therefore no longer a company number anybody could use.
    expect(snapshot.tool).not.toContain('/');
  });
});

describe('silentMetrics', () => {
  it('accepts everything and reports nothing', () => {
    silentMetrics.tool('get_company');
    silentMetrics.upstreamRequest();
    silentMetrics.refused('global');
    silentMetrics.failed('BOOM');
    silentMetrics.ownKey();
    silentMetrics.budget(1, 2);

    expect(silentMetrics.snapshot(7)).toMatchObject({
      tool: 'unknown',
      outcome: 'ok',
      upstreamRequests: 0,
      durationMs: 7
    });
  });
});

describe('the Analytics Engine data point', () => {
  const snapshot: RequestSnapshot = {
    tool: 'screen_companies',
    outcome: 'refused',
    errorCode: 'rate_limited',
    refusalCause: 'client',
    upstreamRequests: 150,
    cacheHits: 12,
    cacheMisses: 38,
    upstreamRetries: 2,
    upstreamThrottled: 1,
    staleServed: 3,
    budgetRemaining: 71,
    budgetLimit: 570,
    ownKey: true,
    durationMs: 4200
  };

  it('lays the columns out in the documented order', () => {
    // Analytics Engine columns are positional — blob1..blob20, double1..
    // double20 — and inserting one in the middle does not migrate old rows, it
    // reinterprets them. Every query and chart over the previous three months
    // then silently reads the wrong field. This test is the reason that
    // cannot happen by accident.
    expect(toDataPoint(snapshot, '0.3.0')).toEqual({
      indexes: ['screen_companies'],
      blobs: ['refused', 'rate_limited', 'client', '0.3.0'],
      doubles: [150, 12, 38, 2, 1, 3, 71, 570, 4200, 1]
    });
  });

  it('uses exactly one index, which is the platform maximum', () => {
    expect(toDataPoint(snapshot, '0.3.0').indexes).toHaveLength(1);
  });

  it('stays far under the twenty-column ceilings', () => {
    const point = toDataPoint(snapshot, '0.3.0');
    expect(point.blobs.length).toBeLessThanOrEqual(20);
    expect(point.doubles.length).toBeLessThanOrEqual(20);
  });

  it('keeps the index inside the 96-byte limit even at the label ceiling', () => {
    const long: RequestSnapshot = { ...snapshot, tool: label('t'.repeat(500)) };
    expect(new TextEncoder().encode(toDataPoint(long, '0.3.0').indexes[0] ?? '').length)
      .toBeLessThanOrEqual(96);
  });

  it('writes a caller with no key of their own as zero', () => {
    expect(toDataPoint({ ...snapshot, ownKey: false }, '0.3.0').doubles[9]).toBe(0);
  });
});

describe('AnalyticsEngineSink', () => {
  it('writes one data point per snapshot', () => {
    const written: unknown[] = [];
    const sink = new AnalyticsEngineSink({
      dataset: { writeDataPoint: (event) => written.push(event) },
      version: '0.3.0'
    });

    sink.write(createRequestMetrics().snapshot(1));
    expect(written).toHaveLength(1);
  });

  it('swallows a write failure rather than failing the request', () => {
    // This runs in the `finally` of a request that has already produced a good
    // answer. A throw here would turn that answer into a 500 — measurement
    // taking down the thing it measures.
    const seen: unknown[] = [];
    const sink = new AnalyticsEngineSink({
      dataset: {
        writeDataPoint: () => {
          throw new Error('dataset unavailable');
        }
      },
      version: '0.3.0',
      onError: (error) => seen.push(error)
    });

    expect(() => sink.write(createRequestMetrics().snapshot(1))).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('is silent about a failure when nobody asked to hear about it', () => {
    const sink = new AnalyticsEngineSink({
      dataset: {
        writeDataPoint: () => {
          throw new Error('nope');
        }
      },
      version: '0.3.0'
    });

    expect(() => sink.write(createRequestMetrics().snapshot(1))).not.toThrow();
  });
});
