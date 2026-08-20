/**
 * The error model.
 *
 * Design rule: an error that reaches the model is data, not a stack trace. A
 * thrown exception serialised into a tool result gives a language model
 * nothing it can act on, so it retries the same call or invents a plausible
 * answer. Every failure here therefore carries three things:
 *
 *   code     — stable, machine-readable, safe to branch on
 *   message  — one plain sentence, no jargon, no stack
 *   nextStep — what to do instead, phrased as an instruction
 *
 * `nextStep` is the field that changes behaviour. "No company with that
 * number" leaves a model stuck; "no company with that number, search by name
 * with find_company" does not.
 */

export const ERROR_CODES = [
  'INVALID_COMPANY_NUMBER',
  'INVALID_ARGUMENT',
  'COMPANY_NOT_FOUND',
  'OFFICER_NOT_FOUND',
  'RESOURCE_NOT_FOUND',
  'AUTH_INVALID',
  'AUTH_FORBIDDEN',
  'RATE_LIMITED',
  'UPSTREAM_BAD_REQUEST',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_MALFORMED',
  'NETWORK_ERROR'
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface CompaniesHouseErrorOptions {
  code: ErrorCode;
  message: string;
  nextStep: string;
  /** Upstream HTTP status, where there was one. */
  status?: number | undefined;
  /** Populated for RATE_LIMITED. Milliseconds until the caller may retry. */
  retryAfterMs?: number | undefined;
  /** Whether retrying the identical request could plausibly succeed. */
  retryable?: boolean;
  cause?: unknown;
  /** Free-form context for logs. Never contains the API key. */
  details?: Record<string, unknown> | undefined;
}

/** The serialised shape handed back to a caller. */
export interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    next_step: string;
    status?: number;
    retry_after_ms?: number;
    retryable: boolean;
  };
}

export class CompaniesHouseError extends Error {
  readonly code: ErrorCode;
  readonly nextStep: string;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(options: CompaniesHouseErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CompaniesHouseError';
    this.code = options.code;
    this.nextStep = options.nextStep;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toPayload(): ErrorPayload {
    const error: ErrorPayload['error'] = {
      code: this.code,
      message: this.message,
      next_step: this.nextStep,
      retryable: this.retryable
    };
    if (this.status !== undefined) error.status = this.status;
    if (this.retryAfterMs !== undefined) error.retry_after_ms = this.retryAfterMs;
    return { error };
  }

  static is(value: unknown): value is CompaniesHouseError {
    return value instanceof CompaniesHouseError;
  }
}

/**
 * Maps an upstream HTTP status onto the error model.
 *
 * `resource` names what was being fetched so that a 404 can say something
 * more useful than "not found". The Companies House API returns 404 both for
 * "this company does not exist" and for "this company exists but has no
 * charges", and those want different next steps — the caller passes
 * `emptyIsNotFound: false` for the second kind.
 */
export function fromHttpStatus(input: {
  status: number;
  resource: string;
  identifier?: string | undefined;
  retryAfterMs?: number | undefined;
  body?: unknown;
}): CompaniesHouseError {
  const { status, resource, identifier, retryAfterMs } = input;
  const subject = identifier === undefined ? resource : `${resource} ${identifier}`;

  switch (status) {
    case 400:
      return new CompaniesHouseError({
        code: 'UPSTREAM_BAD_REQUEST',
        message: `Companies House rejected the request for ${subject} as malformed.`,
        nextStep:
          'Check the arguments against the tool schema. If a company number was supplied, confirm it is eight characters.',
        status,
        details: { body: input.body }
      });

    case 401:
      return new CompaniesHouseError({
        code: 'AUTH_INVALID',
        message: 'Companies House rejected the API key.',
        nextStep:
          'The COMPANIES_HOUSE_API_KEY value is missing, mistyped, or has been revoked. Check it at developer.company-information.service.gov.uk. This is a configuration problem and retrying will not fix it.',
        status
      });

    case 403:
      return new CompaniesHouseError({
        code: 'AUTH_FORBIDDEN',
        message: 'The API key is valid but is not permitted to read this resource.',
        nextStep:
          'Confirm the key is a REST API key for the public data API rather than a streaming key, and that the application is not restricted by IP.',
        status
      });

    case 404:
      return new CompaniesHouseError({
        code: 'RESOURCE_NOT_FOUND',
        message: `Companies House has no ${subject}.`,
        nextStep:
          'If a company number was used, verify it with find_company. A 404 here can also mean the company exists but has nothing filed under this section.',
        status
      });

    case 429:
      return new CompaniesHouseError({
        code: 'RATE_LIMITED',
        message: 'The Companies House rate limit of 600 requests per five minutes has been reached.',
        nextStep:
          retryAfterMs === undefined
            ? 'Wait for the current five-minute window to reset before making further calls.'
            : `Wait ${Math.ceil(retryAfterMs / 1000)} seconds before making further calls.`,
        status,
        retryAfterMs,
        retryable: true
      });

    default:
      if (status >= 500) {
        return new CompaniesHouseError({
          code: 'UPSTREAM_UNAVAILABLE',
          message: `Companies House returned ${status} while fetching ${subject}.`,
          nextStep:
            'This is an upstream fault, not a problem with the request. Retry shortly; if it persists, check the Companies House service status page.',
          status,
          retryable: true
        });
      }
      return new CompaniesHouseError({
        code: 'UPSTREAM_BAD_REQUEST',
        message: `Companies House returned an unexpected status ${status} while fetching ${subject}.`,
        nextStep: 'Report this as a bug against companies-house-mcp with the status code.',
        status,
        details: { body: input.body }
      });
  }
}

export function invalidCompanyNumber(input: string, reason: string): CompaniesHouseError {
  return new CompaniesHouseError({
    code: 'INVALID_COMPANY_NUMBER',
    message: `"${input}" is not a valid company number: ${reason}.`,
    nextStep:
      'Company numbers are eight characters — either eight digits, or a two-character prefix such as SC, NI or OC followed by six digits. If you have a company name rather than a number, call find_company first.',
    details: { input }
  });
}

/**
 * Raised when a retrieval tool is handed a company name.
 *
 * Separate from `invalidCompanyNumber` because the fix is different and the
 * caller is much more likely to act on a message that names what it received.
 */
export function companyNameSupplied(input: string): CompaniesHouseError {
  return new CompaniesHouseError({
    code: 'INVALID_COMPANY_NUMBER',
    message: `"${input}" looks like a company name, not a company number.`,
    nextStep:
      'Call find_company with this name to get candidate company numbers, then call this tool again with the number of the right one. Do not guess a number: a plausible wrong company number returns a real company and nothing will flag it as the wrong one.',
    details: { input }
  });
}

export function timeout(resource: string, timeoutMs: number): CompaniesHouseError {
  return new CompaniesHouseError({
    code: 'UPSTREAM_TIMEOUT',
    message: `Companies House did not respond within ${timeoutMs}ms while fetching ${resource}.`,
    nextStep: 'Retry once. If it happens repeatedly, raise CH_TIMEOUT_MS or check the service status page.',
    retryable: true
  });
}

export function networkError(resource: string, cause: unknown): CompaniesHouseError {
  return new CompaniesHouseError({
    code: 'NETWORK_ERROR',
    message: `Could not reach Companies House while fetching ${resource}.`,
    nextStep: 'Check network connectivity and any outbound proxy configuration, then retry.',
    retryable: true,
    cause
  });
}

export function malformedResponse(resource: string, cause: unknown): CompaniesHouseError {
  return new CompaniesHouseError({
    code: 'UPSTREAM_MALFORMED',
    message: `Companies House returned a response for ${resource} that could not be parsed as JSON.`,
    nextStep:
      'This usually means an outage is returning an HTML error page. Retry shortly; if it persists, check the service status page.',
    retryable: true,
    cause
  });
}
