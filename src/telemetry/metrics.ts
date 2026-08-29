/**
 * What one request did, counted.
 *
 * This is the measurement half of running the server for other people. A
 * hosted deployment spends a rate limit that everybody shares, and without
 * numbers the operator learns that it ran out by trying it. See ADR 16.
 *
 * Three properties, all deliberate:
 *
 * **It is pure.** No clock, no I/O, no platform types. The same accumulator
 * runs in a Node process and inside a Worker isolate, and every rule in here
 * is testable without a runtime — which matters more than usual, because
 * Miniflare's Analytics Engine binding is a no-op stub, so a test in `workerd`
 * can prove a data point was accepted but never what was in it. If the shaping
 * were done in the Cloudflare adapter it would be effectively untestable.
 *
 * **It counts, it does not describe.** Every label it accepts is passed
 * through `label()`, which strips anything that is not a lowercase word
 * character. A company number survives that; but nothing here is ever *given*
 * one, and the two call sites take a tool name and an error code, both drawn
 * from closed sets in this codebase. The sanitiser is the belt to that
 * braces: it means a later change that carelessly passes a URL, a query
 * string or a key emits a mangled label rather than leaking one.
 *
 * **It cannot fail a request.** Every method returns void and swallows
 * nothing, because there is nothing here that can throw: no allocation that
 * grows, no parsing, no formatting. Counters are clamped, so a pathological
 * caller cannot drive a field to `Infinity` and poison a numeric column.
 */

import type { BudgetBound } from '../http/budget.js';

/** Why the limiter said no. Mirrors `BudgetBound`, plus "it did not". */
export type RefusalCause = BudgetBound | 'none';

/**
 * Ceiling on every counter.
 *
 * Analytics columns are doubles, and a number that has run away is worse than
 * useless: it skews every average computed over the dataset and there is no
 * way to tell it from a real reading afterwards. A single invocation cannot
 * legitimately make a million upstream calls — the platform caps subrequests
 * far below that — so anything at the clamp is a bug worth seeing as a
 * suspiciously round number.
 */
const MAX_COUNT = 1_000_000;

/** Longest label emitted. Comfortably longer than any tool name or error code. */
const MAX_LABEL = 48;

/**
 * Reduces a label to something that cannot carry information out.
 *
 * Lowercase letters, digits and underscores only — the shape of every tool
 * name and error code this server defines. Everything else is dropped rather
 * than replaced, so a URL or a company name collapses instead of surviving in
 * a recognisable form.
 */
export function label(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, MAX_LABEL);
}

const clamp = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.round(value), MAX_COUNT));
};

/**
 * One request, reduced to numbers and closed-set labels.
 *
 * Everything an operator needs to answer "is this working, what is it
 * costing, and is anybody being refused" — and nothing about *who* asked or
 * *what* they asked about. See ADR 16 for why that line is drawn where it is.
 */
export interface RequestSnapshot {
  /** The tool called, or `unknown` for a handshake or a malformed request. */
  tool: string;
  /** `ok`, `error`, or `refused` when the limiter turned the request away. */
  outcome: 'ok' | 'error' | 'refused';
  /** The error code, when there was one. Empty otherwise. */
  errorCode: string;
  /** Why the limiter refused, when it did. `none` otherwise. */
  refusalCause: RefusalCause;
  /** Calls actually made to Companies House. The thing that spends the key. */
  upstreamRequests: number;
  /** Answers served from the shared cache, having spent nothing. */
  cacheHits: number;
  cacheMisses: number;
  /** Retries after a failure. High values mean the upstream is struggling. */
  upstreamRetries: number;
  /** 429s from Companies House. Any of these means the key is over its limit. */
  upstreamThrottled: number;
  /** Expired answers served because the upstream was unreachable. */
  staleServed: number;
  /** Budget left for this caller at the end, or -1 if never observed. */
  budgetRemaining: number;
  /** The effective window, or -1 if never observed. */
  budgetLimit: number;
  /** Whether the caller brought their own key, so spent their own window. */
  ownKey: boolean;
  durationMs: number;
}

/**
 * The recording surface.
 *
 * Kept to counters and closed-set labels rather than a general
 * `record(name, value)`, because a general one is how a company number ends up
 * in an analytics column six months from now.
 */
export interface MetricsRecorder {
  tool(name: string): void;
  upstreamRequest(): void;
  cacheHit(): void;
  cacheMiss(): void;
  upstreamRetry(): void;
  upstreamThrottled(): void;
  staleServed(): void;
  refused(cause: BudgetBound): void;
  failed(code: string): void;
  ownKey(): void;
  budget(remaining: number, limit: number): void;
  /** The finished record. `durationMs` is supplied because this owns no clock. */
  snapshot(durationMs: number): RequestSnapshot;
}

/** Where a finished snapshot goes. One implementation per runtime. */
export interface MetricsSink {
  write(snapshot: RequestSnapshot): void;
}

export function createRequestMetrics(): MetricsRecorder {
  let tool = 'unknown';
  let outcome: RequestSnapshot['outcome'] = 'ok';
  let errorCode = '';
  let refusalCause: RefusalCause = 'none';
  let upstreamRequests = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let upstreamRetries = 0;
  let upstreamThrottled = 0;
  let staleServed = 0;
  let budgetRemaining = -1;
  let budgetLimit = -1;
  let ownKey = false;

  return {
    tool: (name) => {
      const clean = label(name);
      if (clean !== '') tool = clean;
    },
    upstreamRequest: () => {
      upstreamRequests = clamp(upstreamRequests + 1);
    },
    cacheHit: () => {
      cacheHits = clamp(cacheHits + 1);
    },
    cacheMiss: () => {
      cacheMisses = clamp(cacheMisses + 1);
    },
    upstreamRetry: () => {
      upstreamRetries = clamp(upstreamRetries + 1);
    },
    upstreamThrottled: () => {
      upstreamThrottled = clamp(upstreamThrottled + 1);
    },
    staleServed: () => {
      staleServed = clamp(staleServed + 1);
    },
    refused: (cause) => {
      // A refusal is the more specific answer, so it wins over a plain error:
      // "somebody was turned away and here is why" is the reading an operator
      // needs, and it would otherwise be indistinguishable from an upstream
      // fault in the same column.
      outcome = 'refused';
      refusalCause = cause;
    },
    failed: (code) => {
      if (outcome !== 'refused') outcome = 'error';
      const clean = label(code);
      if (clean !== '') errorCode = clean;
    },
    ownKey: () => {
      ownKey = true;
    },
    budget: (remaining, limit) => {
      // Last write wins: the figure at the end of the request is the one that
      // says how close to the edge this deployment finished.
      budgetRemaining = clamp(remaining);
      budgetLimit = clamp(limit);
    },
    snapshot: (durationMs) => ({
      tool,
      outcome,
      errorCode,
      refusalCause,
      upstreamRequests,
      cacheHits,
      cacheMisses,
      upstreamRetries,
      upstreamThrottled,
      staleServed,
      budgetRemaining,
      budgetLimit,
      ownKey,
      durationMs: clamp(durationMs)
    })
  };
}

/**
 * Records nothing.
 *
 * The default everywhere, so stdio and an unbound Node deployment carry no
 * measurement machinery they never asked for, and no test has to stub one.
 */
export const silentMetrics: MetricsRecorder = {
  tool: () => {},
  upstreamRequest: () => {},
  cacheHit: () => {},
  cacheMiss: () => {},
  upstreamRetry: () => {},
  upstreamThrottled: () => {},
  staleServed: () => {},
  refused: () => {},
  failed: () => {},
  ownKey: () => {},
  budget: () => {},
  snapshot: (durationMs) => ({
    tool: 'unknown',
    outcome: 'ok',
    errorCode: '',
    refusalCause: 'none',
    upstreamRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    upstreamRetries: 0,
    upstreamThrottled: 0,
    staleServed: 0,
    budgetRemaining: -1,
    budgetLimit: -1,
    ownKey: false,
    durationMs: clamp(durationMs)
  })
};

/** A sink that discards. The default, for the same reason as `silentMetrics`. */
export const silentSink: MetricsSink = { write: () => {} };
