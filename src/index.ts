/**
 * Public surface of the package.
 *
 * Phase 1 ships the transport foundation only: configuration, the HTTP client,
 * the rate limiter, the cache and the error model. The MCP server itself, the
 * tool definitions and the response projections arrive in phase 2, at which
 * point this file also gains the stdio entry point.
 */

export { type Clock, FakeClock, systemClock } from './clock.js';
export {
  type Config,
  ConfigError,
  configSchema,
  defaultCacheDir,
  loadConfig,
  redactConfig
} from './config.js';
export {
  CompaniesHouseError,
  type ErrorCode,
  ERROR_CODES,
  type ErrorPayload,
  fromHttpStatus,
  invalidCompanyNumber,
  malformedResponse,
  networkError,
  timeout
} from './errors.js';
export {
  isValidCompanyNumber,
  KNOWN_PREFIXES,
  looksLikeCompanyName,
  normaliseCompanyNumber,
  type NormalisedCompanyNumber
} from './company-number.js';
export {
  type CacheEntry,
  type CacheLookup,
  DEFAULT_TTLS,
  type ResourceKind,
  ResponseCache
} from './http/cache.js';
export {
  type ClientResponse,
  CompaniesHouseClient,
  type CompaniesHouseClientOptions,
  type GetOptions,
  type QueryParams,
  type RequestMeta
} from './http/client.js';
export { RateLimiter, type RateLimiterOptions, type RateLimitSnapshot } from './http/rate-limiter.js';
export {
  createLogger,
  type LogLevel,
  LOG_LEVELS,
  type Logger,
  silentLogger
} from './telemetry/logger.js';
