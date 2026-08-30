import { describe, expect, it } from 'vitest';

import { AnalyticsEngineSink, toDataPoint } from '../src/cloudflare/analytics-metrics.js';
import { ERROR_CODES } from '../src/errors.js';
import {
  createRequestMetrics,
  label,
  silentMetrics,
  silentSink,
  UNRECOGNISED
} from '../src/telemetry/metrics.js';
import type { RequestSnapshot } from '../src/telemetry/metrics.js';
import { RECORDABLE_ERROR_CODES, RECORDABLE_TOOLS } from '../src/telemetry/recordable.js';

/**
 * The measurement layer, and the limits on it.
 *
 * Two things are being established. The first is arithmetic: that the counters
 * count. The second matters more — that this layer cannot carry a caller's
 * identity or the companies they looked up out of the request. Analytics is
 * retained for three months and read by whoever runs the deployment, so a leak
 * here is not a log line somebody might rotate away.
 *
 * These run under Node deliberately. Miniflare's Analytics Engine binding is
 * `writeDataPoint(_event) {}` — a no-op stub that validates nothing — so a test
 * inside `workerd` can prove a write was accepted and never what was in it, nor
 * whether the platform would have rejected the shape. Keeping the shaping in
 * the portable core is what makes it assertable at all.
 */

const production = () =>
  createRequestMetrics({ tools: RECORDABLE_TOOLS, errorCodes: RECORDABLE_ERROR_CODES });

describe('RequestMetrics counts what a request did', () => {
  it('starts at nothing and reports a clean request as ok', () => {
    expect(production().snapshot(12)).toMatchObject({
      tool: 'unknown',
      outcome: 'ok',
      errorCode: '',
      refusalCause: 'none',
      refusals: 0,
      upstreamRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      durationMs: 12
    });
  });

  it('counts a sub-request that failed and was absorbed into the answer', () => {
    // A snapshot where three of four sections 503 still returns a useful
    // answer, and used to record a clean `ok` row with nothing to say that
    // three quarters of it was missing.
    const metrics = production();
    metrics.tool('company_snapshot');
    for (let i = 0; i < 3; i += 1) metrics.subrequestFailed();

    expect(metrics.snapshot(1)).toMatchObject({ outcome: 'ok', subrequestFailures: 3 });
  });

  it('accumulates the counters a cost question comes back to', () => {
    const metrics = production();
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
    const metrics = production();
    metrics.budget(500, 570);
    metrics.budget(499, 570);
    metrics.budget(496, 570);

    expect(metrics.snapshot(1).budgetRemaining).toBe(496);
  });
});

describe('a refusal is a fact about a sub-request, not about the response', () => {
  it('leaves a request that still answered well as ok', () => {
    // The case that made the refusal query wrong: `screen_companies` sizes its
    // batch, one company is skipped for budget, and the caller gets a complete
    // and correct table saying so. Nobody was refused an answer.
    const metrics = production();
    metrics.tool('screen_companies');
    metrics.refused('client');

    expect(metrics.snapshot(1)).toMatchObject({
      outcome: 'ok',
      refusalCause: 'client',
      refusals: 1
    });
  });

  it('marks a request refused only when it also failed', () => {
    const metrics = production();
    metrics.refused('client');
    metrics.failed('RATE_LIMITED');

    expect(metrics.snapshot(1)).toMatchObject({
      outcome: 'refused',
      refusalCause: 'client',
      errorCode: 'rate_limited',
      refusals: 1
    });
  });

  it('calls a failure with no refusal behind it an error', () => {
    const metrics = production();
    metrics.failed('UPSTREAM_TIMEOUT');
    expect(metrics.snapshot(1)).toMatchObject({ outcome: 'error', refusals: 0 });
  });

  it('counts every refusal in a fan-out, not just the first', () => {
    const metrics = production();
    for (let i = 0; i < 7; i += 1) metrics.refused('client');
    expect(metrics.snapshot(1).refusals).toBe(7);
  });

  it.each(['global', 'client', 'penalty', 'unavailable'] as const)(
    'keeps the cause %s, because the four are four different problems',
    (cause) => {
      const metrics = production();
      metrics.refused(cause);
      expect(metrics.snapshot(1).refusalCause).toBe(cause);
    }
  );

  it('counts a cause outside the closed set, but does not publish it', () => {
    // `boundBy` reaches the recorder from a Durable Object response that the
    // store casts without validating. Two things have to be true at once: the
    // string must not reach a column, and the refusal must still be counted —
    // dropping it made the guard undercount to zero, which is the failure it
    // was written to prevent.
    const metrics = production();
    (metrics.refused as (cause: string) => void)('/company/04138203');

    expect(metrics.snapshot(1)).toMatchObject({ refusalCause: 'other', refusals: 1 });
    expect(JSON.stringify(metrics.snapshot(1))).not.toContain('04138203');
  });
});

describe('counters are clamped', () => {
  it('holds a runaway counter at the ceiling rather than emitting it', () => {
    // An analytics column is a double. One poisoned reading skews every
    // average computed over the dataset afterwards and is indistinguishable
    // from a real one after the fact.
    const metrics = production();
    metrics.budget(5_000_000, 9_000_000);
    const snapshot = metrics.snapshot(1);

    expect(snapshot.budgetRemaining).toBe(1_000_000);
    expect(snapshot.budgetLimit).toBe(1_000_000);
  });

  it('clamps a counter driven up one increment at a time', () => {
    // The ceiling has to hold on the per-increment path too — that is the one
    // a caller can actually drive.
    const metrics = production();
    metrics.budget(1_000_000, 1_000_000);
    for (let i = 0; i < 3; i += 1) metrics.upstreamRequest();
    expect(metrics.snapshot(1).upstreamRequests).toBe(3);
    expect(metrics.snapshot(1).budgetRemaining).toBe(1_000_000);
  });

  it('replaces a non-finite reading with zero', () => {
    const metrics = production();
    metrics.budget(Number.POSITIVE_INFINITY, Number.NaN);
    const snapshot = metrics.snapshot(Number.POSITIVE_INFINITY);

    expect(snapshot.budgetRemaining).toBe(0);
    expect(snapshot.budgetLimit).toBe(0);
    expect(snapshot.durationMs).toBe(0);
  });

  it('never emits a negative or fractional count', () => {
    const metrics = production();
    metrics.budget(-40, -1);
    expect(metrics.snapshot(-5).budgetRemaining).toBe(0);
    expect(metrics.snapshot(2.7).durationMs).toBe(3);
  });
});

describe('what may be recorded is an allowlist, not a character filter', () => {
  // The distinction the first version of this got wrong. `label()` keeps
  // [a-z0-9_], and a company number is eight characters drawn from exactly
  // that set — so filtering cannot tell `get_company` from `sc123456`. Only
  // membership of a set this codebase defines can.

  it.each([
    ['a bare company number', 'SC123456'],
    ['a path with one in it', '/company/04138203'],
    ['a search query', '?q=greggs+plc&items_per_page=20'],
    ['a company name', 'GREGGS PLC'],
    ['an email address', 'user@example.com'],
    ['a bearer token', 'Bearer sk-live-abcdef0123456789'],
    ['an absolute upstream URL', 'https://api.company-information.service.gov.uk/company/04138203']
  ])('records %s as `other`, publishing none of it', (_what, value) => {
    const metrics = production();
    metrics.tool(value);
    metrics.failed(value);

    const snapshot = metrics.snapshot(1);
    expect(snapshot.tool).toBe(UNRECOGNISED);
    expect(snapshot.errorCode).toBe(UNRECOGNISED);
    // Nothing recognisable from the input reaches the row.
    expect(JSON.stringify(snapshot)).not.toContain('04138203');
    expect(JSON.stringify(snapshot)).not.toContain('123456');
    expect(JSON.stringify(snapshot)).not.toContain('greggs');
  });

  it('records every real tool under its own name', () => {
    // The allowlist has to be permissive enough to be useful, or every row
    // reads `other` and the dataset is worthless.
    for (const name of RECORDABLE_TOOLS) {
      const metrics = production();
      metrics.tool(name);
      expect(metrics.snapshot(1).tool).toBe(name);
    }
  });

  it('records every typed error code', () => {
    for (const code of ERROR_CODES) {
      const metrics = production();
      metrics.failed(code);
      expect(metrics.snapshot(1).errorCode).toBe(code.toLowerCase());
    }
  });

  it('still marks the request failed even when the code is unrecognised', () => {
    // Losing the label must not lose the fact that something went wrong.
    const metrics = production();
    metrics.failed('something the sdk invented');
    expect(metrics.snapshot(1)).toMatchObject({ outcome: 'error', errorCode: UNRECOGNISED });
  });
});

describe('label', () => {
  // Kept as a normaliser and tested as one. It is deliberately no longer
  // described as a redaction step: it cannot be, and saying so was the defect.
  it.each([
    ['GREGGS PLC', 'greggsplc'],
    ['get_company', 'get_company'],
    ['RATE_LIMITED', 'rate_limited'],
    ['ab\ncd', 'abcd']
  ])('normalises %s to %s', (input, expected) => {
    expect(label(input)).toBe(expected);
  });

  it('bounds the length so no label can grow without limit', () => {
    expect(label('a'.repeat(500))).toHaveLength(48);
  });

  it('does not pretend to redact: an identifier survives it intact', () => {
    // Pinned deliberately. If someone later reads the sanitiser as a privacy
    // control, this says plainly that it is not one — the allowlist above is.
    expect(label('SC123456')).toBe('sc123456');
    expect(label('/company/04138203')).toBe('company04138203');
  });
});

describe('the no-op implementations', () => {
  it('silentMetrics accepts everything and reports nothing', () => {
    silentMetrics.tool('get_company');
    silentMetrics.upstreamRequest();
    silentMetrics.refused('global');
    silentMetrics.failed('BOOM');
    silentMetrics.ownKey();
    silentMetrics.budget(1, 2);

    expect(silentMetrics.snapshot(7)).toMatchObject({
      tool: 'unknown',
      outcome: 'ok',
      refusals: 0,
      upstreamRequests: 0,
      durationMs: 7
    });
  });

  it('silentSink accepts a snapshot without doing anything with it', () => {
    expect(() => silentSink.write(production().snapshot(1))).not.toThrow();
  });
});

describe('the Analytics Engine data point', () => {
  // Every double is distinct, so a column swap cannot produce an identical
  // array and slip past `toEqual`. The first fixture had `1` in two slots.
  const snapshot: RequestSnapshot = {
    tool: 'screen_companies',
    outcome: 'refused',
    errorCode: 'rate_limited',
    refusalCause: 'client',
    refusals: 9,
    upstreamRequests: 150,
    cacheHits: 12,
    cacheMisses: 38,
    upstreamRetries: 2,
    upstreamThrottled: 3,
    staleServed: 5,
    subrequestFailures: 6,
    budgetRemaining: 71,
    budgetLimit: 570,
    ownKey: true,
    durationMs: 4200
  };

  it('lays the columns out in the documented order', () => {
    // Analytics Engine columns are positional — blob1..blob20, double1..
    // double20 — and inserting one in the middle does not migrate old rows, it
    // reinterprets them. Every query and chart over the previous three months
    // then silently reads the wrong field.
    expect(toDataPoint(snapshot, '0.3.0')).toEqual({
      indexes: ['screen_companies'],
      blobs: ['refused', 'rate_limited', 'client', '0.3.0'],
      doubles: [150, 12, 38, 2, 3, 5, 71, 570, 4200, 1, 9, 6]
    });
  });

  it('carries the deployed version, so a regression can be pinned to a deploy', () => {
    expect(toDataPoint(snapshot, '1.2.3').blobs[3]).toBe('1.2.3');
  });

  it('writes a caller with no key of their own as zero', () => {
    expect(toDataPoint({ ...snapshot, ownKey: false }, '0.3.0').doubles[9]).toBe(0);
  });

  it('stays inside the platform ceilings for a maximal snapshot', () => {
    // Asserted against the real limits rather than against the literal lengths
    // of the arrays above, and with every field at its widest, so this fails
    // if a future column pushes past what the platform accepts. The workerd
    // suite cannot check this: Miniflare's binding validates nothing.
    const widest: RequestSnapshot = {
      ...snapshot,
      tool: label('t'.repeat(500)),
      errorCode: label('e'.repeat(500)),
      outcome: 'refused'
    };
    const point = toDataPoint(widest, '99.99.99-rc.1');
    const bytes = (value: string): number => new TextEncoder().encode(value).length;

    expect(point.indexes).toHaveLength(1);
    expect(bytes(point.indexes[0] ?? '')).toBeLessThanOrEqual(96);
    expect(point.blobs.length).toBeLessThanOrEqual(20);
    expect(point.doubles.length).toBeLessThanOrEqual(20);
    expect(point.blobs.reduce((total, blob) => total + bytes(blob), 0)).toBeLessThanOrEqual(16_384);
  });
});

describe('AnalyticsEngineSink', () => {
  it('writes one data point per snapshot', () => {
    const written: unknown[] = [];
    const sink = new AnalyticsEngineSink({
      dataset: { writeDataPoint: (event) => written.push(event) },
      version: '0.3.0'
    });

    sink.write(production().snapshot(1));
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

    expect(() => sink.write(production().snapshot(1))).not.toThrow();
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

    expect(() => sink.write(production().snapshot(1))).not.toThrow();
  });
});
