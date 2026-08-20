/**
 * Public surface of the package.
 *
 * The executable is `bin.ts`, not this file — importing the library must never
 * start a server or read the environment as a side effect.
 *
 * Phases 1 to 3 are here: configuration, HTTP client, rate limiter, cache,
 * error model, projections, output schemas, all eleven tools and the server
 * factory.
 */

export { attempt, type Attempt, DEFAULT_CONCURRENCY, mapWithConcurrency } from './concurrency.js';
export {
  buildSnapshot,
  type SectionFailure,
  type SnapshotInput,
  type SnapshotSection
} from './domain/snapshot.js';
export { deriveSignals, type Signal, type SignalCode, SIGNAL_CODES } from './domain/signals.js';
export { COMPOSITE_TOOL_NAMES, registerCompositeTools } from './tools/composite.js';

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
