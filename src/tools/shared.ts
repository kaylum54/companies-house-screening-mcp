import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { normaliseCompanyNumber } from '../company-number.js';
import type { Meta } from '../domain/schemas.js';
import { CompaniesHouseError, companyNameSupplied } from '../errors.js';
import type { RequestMeta } from '../http/client.js';
import { CompaniesHouseClient } from '../http/client.js';
import type { RateLimitSnapshot } from '../http/rate-limiter.js';
import type { Logger } from '../telemetry/logger.js';
import type { MetricsRecorder } from '../telemetry/metrics.js';
import { silentMetrics } from '../telemetry/metrics.js';

/** What every tool handler needs. Passed explicitly rather than reached for. */
/**
 * Longest search string accepted.
 *
 * A registered company name is capped at 160 characters by the Companies Act,
 * so 256 is generous for every legitimate input. The bound exists because this
 * server can be deployed authless: without it, `screen_companies` accepts
 * fifty unbounded strings, each of which is trimmed into a Set, URL-encoded
 * into a query, hashed for a cache key, and then echoed back in both
 * `content[0].text` and `structuredContent` — so an attacker's own input is
 * amplified through the isolate more than twice over, bounded only by the
 * platform's body limit.
 */
export const MAX_QUERY_LENGTH = 256;

export interface ToolContext {
  client: CompaniesHouseClient;
  logger: Logger;
  now: () => number;
  /**
   * Where this request is counted. Optional, defaulting to counting nothing,
   * so stdio and every existing test carry no measurement machinery.
   */
  metrics?: MetricsRecorder | undefined;
}

/**
 * The result shape a tool callback returns.
 *
 * Aliased to the SDK's own type rather than restated locally, so that a change
 * to the protocol shows up as a compile error here instead of as a runtime
 * mismatch in somebody's client.
 */
export type ToolResult = CallToolResult;

// --- reusable input fields ------------------------------------------------

export const companyNumberInput = z
  .string()
  .describe(
    'Eight-character Companies House number, such as 00000006 or SC123456. Leading zeros may be omitted. This tool does not accept a company name — call find_company first if that is all you have.'
  );

export const verboseInput = z
  .boolean()
  .optional()
  .describe(
    'Also return the untouched Companies House payload under `raw`, alongside the shaped result. Roughly two and a half times the size; use it only when a field you need is missing from the shaped result.'
  );

export const startIndexInput = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Zero-based offset into the full result set. Use pagination.has_more to decide.');

export const itemsPerPageInput = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('How many records to return. Defaults to the API default; the maximum is 100.');

// --- the no-names rule ----------------------------------------------------

/**
 * Turns caller input into a company number, or refuses.
 *
 * Retrieval tools accept a number and reject a name outright. Given a name, a
 * model will produce a number that looks right, and a plausible wrong company
 * number is the most dangerous failure in this domain: it returns a real
 * company with real directors and real charges, and nothing downstream marks
 * it as the wrong one. A refusal that names the next tool costs one extra
 * call. The alternative costs somebody a bad decision about a real business.
 */
export function resolveCompanyNumber(input: string): string {
  if (looksLikeName(input)) throw companyNameSupplied(input);
  return normaliseCompanyNumber(input).value;
}

function looksLikeName(input: string): boolean {
  // Three or more consecutive letters never occurs in a valid company number,
  // whose prefixes are at most two characters.
  return /[a-z]{3,}/i.test(input.trim());
}

// --- result envelopes -----------------------------------------------------

export function buildMeta(meta: RequestMeta): Meta {
  const base: Meta = {
    cached: meta.cached,
    stale: meta.stale,
    rate_limit_remaining: meta.rateLimit.remaining,
    rate_limit_resets_in_ms: meta.rateLimit.resetInMs,
    licence: 'OGL-v3.0'
  };
  // Only meaningful for a cached answer, and the caller needs it most when
  // `stale` is true and the number is large.
  if (meta.ageMs !== undefined) {
    base.age_seconds = Math.max(Math.round(meta.ageMs / 1000), 0);
  }
  return base;
}

/**
 * Combines the metadata of several requests into one envelope.
 *
 * The composite tools make up to four requests per company. The rules are
 * chosen so that the summary never flatters the answer: it is only `cached`
 * if every part was, it is `stale` if any part was, and the age reported is
 * the oldest. A snapshot that is three-quarters fresh and one-quarter two
 * days old should read as two days old.
 */
export function mergeMeta(metas: RequestMeta[], rateLimit: RateLimitSnapshot): Meta {
  const base: Meta = {
    cached: metas.length > 0 && metas.every((meta) => meta.cached),
    stale: metas.some((meta) => meta.stale),
    rate_limit_remaining: rateLimit.remaining,
    rate_limit_resets_in_ms: rateLimit.resetInMs,
    licence: 'OGL-v3.0'
  };

  const ages = metas
    .map((meta) => meta.ageMs)
    .filter((age): age is number => age !== undefined);
  if (ages.length > 0) {
    base.age_seconds = Math.max(Math.round(Math.max(...ages) / 1000), 0);
  }

  return base;
}

/**
 * Success envelope.
 *
 * The same object goes out twice: once as `structuredContent` for hosts that
 * read it, once as compact JSON text for hosts that do not. That duplication
 * is a real token cost and it is deliberate — see ADR 6 for the alternative
 * that was considered and rejected.
 */
export function ok(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured
  };
}

/**
 * Failure envelope.
 *
 * `isError: true` makes the SDK skip output-schema validation, so an error
 * result does not have to pretend to be a successful one. The payload carries
 * the code, the sentence and the next step.
 */
export function fail(error: unknown, logger: Logger, metrics: MetricsRecorder = silentMetrics): ToolResult {
  if (CompaniesHouseError.is(error)) {
    logger.debug('tool returned an error', { code: error.code, status: error.status });
    metrics.failed(error.code);
    return {
      content: [{ type: 'text', text: JSON.stringify(error.toPayload()) }],
      isError: true
    };
  }

  // An unexpected throw is a bug in this server, not a Companies House
  // problem, and it should read as one rather than being dressed up as an
  // upstream fault.
  logger.error('unexpected error in tool handler', { error });
  metrics.failed('internal_error');
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'companies-house-screening-mcp hit an unexpected internal error.',
            next_step:
              'This is a bug in the server rather than a problem with the request. Retrying the same call is unlikely to help; please report it with the tool name and arguments.',
            retryable: false
          }
        })
      }
    ],
    isError: true
  };
}

/**
 * Wraps a handler so no exception escapes into the transport, and counts it.
 *
 * Every tool goes through here, which is why the measurement lives here too:
 * the name and the outcome are recorded by the wrapper rather than by each
 * handler, so a tool added next year is counted without anybody remembering
 * to count it. The signature takes the whole context rather than a logger
 * precisely so that it cannot be called without the recorder in reach.
 */
export async function guard(
  context: ToolContext,
  tool: string,
  run: () => Promise<ToolResult>
): Promise<ToolResult> {
  const metrics = context.metrics ?? silentMetrics;
  metrics.tool(tool);
  try {
    return await run();
  } catch (error) {
    return fail(error, context.logger, metrics);
  }
}

/** Adds the raw payload only when the caller asked for it. */
export function withRaw<T extends Record<string, unknown>>(
  body: T,
  raw: unknown,
  verbose: boolean | undefined
): Record<string, unknown> {
  return verbose === true ? { ...body, raw } : body;
}
