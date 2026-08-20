/**
 * Public surface of the package.
 *
 * The executable is `bin.ts`, not this file — importing the library must never
 * start a server or read the environment as a side effect.
 *
 * Phases 1 and 2 are here: configuration, HTTP client, rate limiter, cache,
 * error model, projections, output schemas, the nine tools and the server
 * factory. The composite tools arrive in phase 3.
 */

export {
  projectCharges,
  projectCompanyProfile,
  projectCompanySearch,
  projectFilingHistory,
  projectInsolvency,
  projectOfficerAppointments,
  projectOfficerSearch,
  projectOfficers,
  projectPsc
} from './domain/projections.js';
export * as schemas from './domain/schemas.js';
export { createServer, INSTRUCTIONS, SERVER_NAME } from './server.js';
export { registerTools, TOOL_NAMES } from './tools/definitions.js';
export { type ToolContext, type ToolResult } from './tools/shared.js';
export { packageVersion } from './version.js';

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
