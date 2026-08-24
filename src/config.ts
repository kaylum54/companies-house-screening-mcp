import { z } from 'zod';

import { LOG_LEVELS } from './telemetry/logger.js';

/**
 * Configuration is read once, validated once, and passed down explicitly.
 *
 * Nothing below reads `process.env` at call time. A server whose behaviour
 * depends on ambient state that can change mid-process is a server whose bugs
 * cannot be reproduced.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return !['false', '0', 'no', 'off', ''].includes(value.trim().toLowerCase());
  });

const positiveInt = (label: string) =>
  z.coerce
    .number()
    .int(`${label} must be a whole number`)
    .positive(`${label} must be greater than zero`);

export const configSchema = z.object({
  apiKey: z
    .string({ error: 'COMPANIES_HOUSE_API_KEY is required' })
    .min(1, 'COMPANIES_HOUSE_API_KEY is required'),
  baseUrl: z.url('CH_API_BASE_URL must be a valid URL').default('https://api.company-information.service.gov.uk'),

  rateLimit: positiveInt('CH_RATE_LIMIT').default(600),
  rateWindowMs: positiveInt('CH_RATE_WINDOW_MS').default(300_000),
  rateSafetyMargin: z.coerce.number().gt(0).lte(1).default(0.95),

  cacheEnabled: booleanish.default(true),
  /**
   * Optional: only a runtime with a filesystem has anywhere to put this. The
   * Node entry points resolve a platform default via `defaultCacheDir`; a
   * Worker leaves it unset and supplies a KV-backed store instead.
   */
  cacheDir: z.string().min(1).optional(),

  timeoutMs: positiveInt('CH_TIMEOUT_MS').default(10_000),
  maxRetries: z.coerce.number().int().min(0).max(10).default(3),
  retryBaseMs: positiveInt('CH_RETRY_BASE_MS').default(500),

  userAgent: z.string().min(1).default('companies-house-screening-mcp'),
  logLevel: z.enum(LOG_LEVELS).default('info'),

  // ---- Hosted deployment. Ignored entirely by the stdio entry point. ----

  httpPort: positiveInt('CH_HTTP_PORT').default(8787),
  /**
   * Loopback by default. A server that binds every interface the moment it
   * starts is one `npm start` away from being on the office network, and this
   * one holds an API key. Deployments that mean to be reachable say so.
   */
  httpHost: z.string().min(1).default('127.0.0.1'),
  /**
   * Origins permitted to reach the endpoint from a browser. Empty means none,
   * which is correct: MCP clients are not browsers and send no Origin, so an
   * empty list blocks browser-driven requests without affecting real callers.
   */
  allowedOrigins: z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (typeof value === 'string' ? value.split(',') : value)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
    )
    .default([]),
  /** Largest request body accepted, in bytes. */
  maxRequestBytes: positiveInt('CH_MAX_REQUEST_BYTES').default(1_048_576),

  /**
   * Requests each caller is guaranteed within a window. Unset disables fair
   * sharing, which is right for stdio and wrong for anything shared; the HTTP
   * entry points derive a default from the effective limit when it is unset.
   */
  clientReservation: positiveInt('CH_CLIENT_RESERVATION').optional(),
  /** How many not-yet-seen callers to hold a reservation free for. */
  newcomerAllowance: z.coerce.number().int().min(0).max(100).default(1),
  /** Upper bound on distinct callers tracked for fair sharing. */
  maxTrackedClients: positiveInt('CH_MAX_TRACKED_CLIENTS').default(10_000),
  /** Whether a caller may supply their own Companies House key. */
  allowClientKeys: booleanish.default(true),
  /** How long a request will wait for budget before failing with RATE_LIMITED. */
  maxWaitMs: positiveInt('CH_MAX_WAIT_MS').default(60_000)
});

export type Config = z.infer<typeof configSchema>;

/**
 * Config field back to the environment variable that sets it. Error messages
 * quote the name the reader can actually search for, not the internal one.
 */
const ENV_NAMES: Record<string, string> = {
  apiKey: 'COMPANIES_HOUSE_API_KEY',
  baseUrl: 'CH_API_BASE_URL',
  rateLimit: 'CH_RATE_LIMIT',
  rateWindowMs: 'CH_RATE_WINDOW_MS',
  rateSafetyMargin: 'CH_RATE_SAFETY_MARGIN',
  cacheEnabled: 'CH_CACHE_ENABLED',
  cacheDir: 'CH_CACHE_DIR',
  timeoutMs: 'CH_TIMEOUT_MS',
  maxRetries: 'CH_MAX_RETRIES',
  retryBaseMs: 'CH_RETRY_BASE_MS',
  userAgent: 'CH_USER_AGENT',
  logLevel: 'CH_LOG_LEVEL',
  httpPort: 'CH_HTTP_PORT',
  httpHost: 'CH_HTTP_HOST',
  allowedOrigins: 'CH_ALLOWED_ORIGINS',
  maxRequestBytes: 'CH_MAX_REQUEST_BYTES',
  clientReservation: 'CH_CLIENT_RESERVATION',
  newcomerAllowance: 'CH_NEWCOMER_ALLOWANCE',
  maxTrackedClients: 'CH_MAX_TRACKED_CLIENTS',
  allowClientKeys: 'CH_ALLOW_CLIENT_KEYS',
  maxWaitMs: 'CH_MAX_WAIT_MS'
};

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Configuration is invalid:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Builds configuration from environment variables.
 *
 * @throws {ConfigError} listing every problem at once. Reporting one missing
 * variable per restart is a poor way to treat somebody setting the thing up
 * for the first time.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const candidate = {
    apiKey: env['COMPANIES_HOUSE_API_KEY'],
    baseUrl: env['CH_API_BASE_URL'],
    rateLimit: env['CH_RATE_LIMIT'],
    rateWindowMs: env['CH_RATE_WINDOW_MS'],
    rateSafetyMargin: env['CH_RATE_SAFETY_MARGIN'],
    cacheEnabled: env['CH_CACHE_ENABLED'],
    cacheDir: env['CH_CACHE_DIR'],
    timeoutMs: env['CH_TIMEOUT_MS'],
    maxRetries: env['CH_MAX_RETRIES'],
    retryBaseMs: env['CH_RETRY_BASE_MS'],
    userAgent: env['CH_USER_AGENT'],
    logLevel: env['CH_LOG_LEVEL'],
    httpPort: env['CH_HTTP_PORT'],
    httpHost: env['CH_HTTP_HOST'],
    allowedOrigins: env['CH_ALLOWED_ORIGINS'],
    maxRequestBytes: env['CH_MAX_REQUEST_BYTES'],
    clientReservation: env['CH_CLIENT_RESERVATION'],
    newcomerAllowance: env['CH_NEWCOMER_ALLOWANCE'],
    maxTrackedClients: env['CH_MAX_TRACKED_CLIENTS'],
    allowClientKeys: env['CH_ALLOW_CLIENT_KEYS'],
    maxWaitMs: env['CH_MAX_WAIT_MS']
  };

  // Strip undefined so that zod applies defaults rather than failing on them.
  const cleaned = Object.fromEntries(
    Object.entries(candidate).filter(([, value]) => value !== undefined)
  );

  const result = configSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const field = issue.path.join('.');
        const name = ENV_NAMES[field] ?? field;
        if (name === '') return issue.message;
        // Do not repeat the variable name when the message already carries it.
        return issue.message.includes(name) ? issue.message : `${name}: ${issue.message}`;
      })
    );
  }

  return result.data;
}

/**
 * Redacts the API key for logging. The key is a bearer credential; it must
 * never appear in a log line, an error message, or a cache file path.
 */
export function redactConfig(config: Config): Record<string, unknown> {
  const { apiKey, ...rest } = config;
  return { ...rest, apiKey: apiKey.length === 0 ? '(empty)' : `${apiKey.slice(0, 4)}…(redacted)` };
}
