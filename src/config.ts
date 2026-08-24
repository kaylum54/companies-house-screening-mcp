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
  logLevel: z.enum(LOG_LEVELS).default('info')
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
  logLevel: 'CH_LOG_LEVEL'
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
    logLevel: env['CH_LOG_LEVEL']
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
