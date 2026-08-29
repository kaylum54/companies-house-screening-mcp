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

/** Why the limiter said no: a `BudgetBound`, "it did not", or one we do not know. */
export type RefusalCause = BudgetBound | 'none' | 'other';

/** The only values `refusalCause` may take. Checked, not assumed. */
const REFUSAL_CAUSES: readonly BudgetBound[] = ['global', 'client', 'penalty', 'unavailable'];

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
 * Normalises a label. **This is not a leak-prevention control.**
 *
 * It lowercases and keeps `[a-z0-9_]`, which is the shape of every tool name
 * and error code this server defines — but a company number is eight
 * characters drawn from exactly that set, so `label('SC123456')` returns
 * `'sc123456'`, intact. Anything under 48 word characters survives in a
 * readable form. Treating this as a redaction step was the mistake; the real
 * guarantee is `permitted()` below.
 */
export function label(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, MAX_LABEL);
}

/**
 * The actual guarantee: a label is emitted only if it is a value this
 * codebase defines.
 *
 * An allowlist rather than a filter, because a filter cannot distinguish
 * `get_company` from `sc123456` — both are lowercase word characters, and a
 * character class has no way to tell a tool name from a company number. Every
 * caller today passes a literal or a closed-set error code, so this changes
 * nothing about what is recorded; what it changes is that a future call site
 * handing over a path, a query or a session id records `other` instead of
 * publishing it for three months.
 *
 * The allowed sets live where they are defined, and are passed in rather than
 * imported, so that this module keeps no dependency on the tool registry.
 */
function permitted(value: string, allowed: ReadonlySet<string>): string | undefined {
  const clean = label(value);
  return allowed.has(clean) ? clean : undefined;
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
  /**
   * What the caller got.
   *
   * `refused` is narrower than it looks: it means the request **failed** and
   * the limiter had turned something away. A `screen_companies` run where one
   * company was skipped for budget but the table came back complete and
   * correct is `ok` — it was not refused, part of it was, and `refusals`
   * below is where that shows. Marking the whole request `refused` counted
   * successful responses as rejections in the one query built to find them.
   */
  outcome: 'ok' | 'error' | 'refused';
  /** The error code, when there was one. Empty otherwise. */
  errorCode: string;
  /** Why the limiter refused, when it did. `none` otherwise. */
  refusalCause: RefusalCause;
  /**
   * How many sub-requests the limiter turned away.
   *
   * Separate from `outcome` because a fan-out can have some refused and still
   * answer well. Non-zero with `outcome: 'ok'` is the honest shape of a batch
   * that came back short and said so.
   */
  refusals: number;
  /** Calls actually made to Companies House. The thing that spends the key. */
  upstreamRequests: number;
  /** Answers served from the shared cache, having spent nothing. */
  cacheHits: number;
  cacheMisses: number;
  /**
   * Retries after a failure — a **subset** of `upstreamRequests`, not extra.
   *
   * A call that failed three times then succeeded records 4 requests and 3
   * retries. Adding them double-counts; dividing them reads 75% for a request
   * that worked.
   */
  upstreamRetries: number;
  /** 429s from Companies House. Any of these means the key is over its limit. */
  upstreamThrottled: number;
  /** Expired answers served because the upstream was unreachable. */
  staleServed: number;
  /**
   * Sub-requests that failed and were absorbed into the answer.
   *
   * The composite tools deliberately do not fail a whole snapshot because one
   * section 404ed or 503ed — they report the section as unavailable and carry
   * on, which is right for the caller and invisible to everyone else. Without
   * this, a Companies House wobble that degrades every answer on the server
   * produces a dataset of clean `ok` rows.
   */
  subrequestFailures: number;
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
  subrequestFailed(): void;
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

export interface RequestMetricsOptions {
  /** Tool names that may be recorded. Anything else is recorded as `other`. */
  tools: Iterable<string>;
  /** Error codes that may be recorded. Anything else is recorded as `other`. */
  errorCodes: Iterable<string>;
}

/** What an unrecognised label becomes. Visible in a query, useless to an attacker. */
export const UNRECOGNISED = 'other';

export function createRequestMetrics(options: RequestMetricsOptions): MetricsRecorder {
  const allowedTools = new Set([...options.tools].map(label));
  const allowedCodes = new Set([...options.errorCodes].map(label));
  let tool = 'unknown';
  let outcome: RequestSnapshot['outcome'] = 'ok';
  let errorCode = '';
  let refusalCause: RefusalCause = 'none';
  let refusals = 0;
  let upstreamRequests = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let upstreamRetries = 0;
  let upstreamThrottled = 0;
  let staleServed = 0;
  let subrequestFailures = 0;
  let budgetRemaining = -1;
  let budgetLimit = -1;
  let ownKey = false;

  return {
    tool: (name) => {
      tool = permitted(name, allowedTools) ?? UNRECOGNISED;
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
    subrequestFailed: () => {
      subrequestFailures = clamp(subrequestFailures + 1);
    },
    refused: (cause) => {
      // Validated rather than trusted. `boundBy` reaches here from a Durable
      // Object response that `do-budget-store.ts` casts without checking, so
      // this is the last point at which a changed remote shape can be stopped
      // from writing an arbitrary string into an analytics column.
      refusals = clamp(refusals + 1);
      // Counted first, then labelled. Returning early on an unknown cause
      // defeated the guard's own purpose: a changed Durable Object shape would
      // have silently undercounted refusals to zero rather than recording that
      // some happened for a reason we could not name.
      refusalCause = REFUSAL_CAUSES.includes(cause) ? cause : UNRECOGNISED;
      // Deliberately does not touch `outcome`. A refusal is a fact about one
      // sub-request; whether the caller ended up with an answer is a fact
      // about the request, and `failed` is what knows it.
    },
    failed: (code) => {
      // A failure with a refusal behind it is the more specific answer, and
      // the one an operator needs: "turned away, and here is why" rather than
      // an upstream fault in the same column.
      outcome = refusals > 0 ? 'refused' : 'error';
      errorCode = permitted(code, allowedCodes) ?? UNRECOGNISED;
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
      refusals,
      upstreamRequests,
      cacheHits,
      cacheMisses,
      upstreamRetries,
      upstreamThrottled,
      staleServed,
      subrequestFailures,
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
  subrequestFailed: () => {},
  refused: () => {},
  failed: () => {},
  ownKey: () => {},
  budget: () => {},
  snapshot: (durationMs) => ({
    tool: 'unknown',
    outcome: 'ok',
    errorCode: '',
    refusalCause: 'none',
    refusals: 0,
    upstreamRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    upstreamRetries: 0,
    upstreamThrottled: 0,
    staleServed: 0,
    subrequestFailures: 0,
    budgetRemaining: -1,
    budgetLimit: -1,
    ownKey: false,
    durationMs: clamp(durationMs)
  })
};

/** A sink that discards. The default, for the same reason as `silentMetrics`. */
export const silentSink: MetricsSink = { write: () => {} };
