import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import type { BudgetStore } from '../http/budget-store.js';
import { MemoryBudgetStore } from '../http/budget-store.js';
import type { ResponseCache } from '../http/cache.js';
import { CompaniesHouseClient } from '../http/client.js';
import { RateLimiter, SERVER_MAX_WAIT_MS } from '../http/rate-limiter.js';
import { createServer } from '../server.js';
import type { Logger } from '../telemetry/logger.js';
import type { ClientIdentity } from './identity.js';

/**
 * Turning an authenticated caller into an MCP server.
 *
 * The interesting decision is what gets shared and what does not, because it
 * is the whole economic argument for hosting this at all:
 *
 * - **The cache is shared by everyone, always.** The register is public, and a
 *   company profile fetched with one key is byte-for-byte the profile fetched
 *   with another. Partitioning it per caller would multiply upstream cost for
 *   no privacy gain, since there is no private data in it to leak. One warm
 *   cache serving every session is most of why a shared server beats fifty
 *   laptops each starting cold.
 *
 * - **The budget is shared only by callers on the same key.** Companies House
 *   meters per key, so the key is the unit. Sessions on the pooled key share
 *   one window and are held to fair shares within it. A session that brought
 *   its own key gets a window of its own: it cannot be starved by the pool,
 *   and cannot starve it.
 *
 * See ADR 13.
 */

export interface SessionFactoryOptions {
  /** Configuration for the pooled key. */
  config: Config;
  logger: Logger;
  clock: Clock;
  version: string;
  /** Shared by every session, whatever key they are spending. */
  cache: ResponseCache;
  /** The pooled-key client. Sessions without their own key get a view of it. */
  pooledClient: CompaniesHouseClient;
  /**
   * Builds a private budget for a caller who brought their own key.
   *
   * Injected because the answer differs by runtime: an in-memory store in a
   * single Node process, a Durable Object stub on Cloudflare.
   */
  createBudgetStore: (label: string) => BudgetStore;
  /**
   * Injectable for tests. Must reach the private client too: building the
   * pooled and private clients differently is how the bring-your-own-key path
   * ends up untested and then untrue.
   */
  fetchImpl?: typeof fetch | undefined;
}

export interface Session {
  server: McpServer;
  client: CompaniesHouseClient;
}

export function createSession(options: SessionFactoryOptions, identity: ClientIdentity): Session {
  // A caller who supplies the deployment's *own* key is not bringing a second
  // credential, and must not be handed a second window on the first one:
  // Companies House meters the key, so two windows on one key would let this
  // server spend roughly twice the allowance it actually has. They go in the
  // pool, which is where that key's traffic already is.
  const bringsOwnKey =
    identity.apiKey !== undefined && identity.apiKey !== options.config.apiKey;

  const client = bringsOwnKey
    ? buildPrivateClient(options, identity.apiKey as string, identity.clientId)
    : // Pooled key: same cache, same window, its own share of it.
      options.pooledClient.withClientId(identity.clientId);

  const server = createServer(
    { client, logger: options.logger, now: () => options.clock.now() },
    options.version
  );

  return { server, client };
}

/**
 * A client spending the caller's own key against their own window.
 *
 * Fair sharing is deliberately switched off here: the whole point of bringing
 * a key is that its 600 per five minutes is yours, so slicing it into shares
 * for callers who by definition cannot reach it would only make it smaller.
 * The shared cache is still passed in, because public data is public data and
 * a private budget goes further against a warm cache than a cold one.
 */
function buildPrivateClient(
  options: SessionFactoryOptions,
  apiKey: string,
  clientId: string
): CompaniesHouseClient {
  const config: Config = { ...options.config, apiKey };

  const limiter = new RateLimiter({
    clock: options.clock,
    maxWaitMs: config.maxWaitMs ?? SERVER_MAX_WAIT_MS,
    store: options.createBudgetStore(clientId),
    limit: config.rateLimit,
    windowMs: config.rateWindowMs,
    safetyMargin: config.rateSafetyMargin
  });

  return new CompaniesHouseClient({
    config,
    logger: options.logger,
    clock: options.clock,
    cache: options.cache,
    limiter,
    clientId,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });
}

/**
 * The reservation each caller on the pooled key is guaranteed.
 *
 * An eighth of the effective window by default, which is 71 of 570 — enough
 * for a `company_snapshot` and change, or roughly 23 companies of a
 * `screen_companies` run at three sections each. Small enough that eight
 * simultaneous callers all fit, large enough that a single lookup never
 * queues. Operators who know their own traffic should set it directly.
 */
export function defaultClientReservation(config: Config): number {
  if (config.clientReservation !== undefined) return config.clientReservation;
  const effective = Math.max(1, Math.floor(config.rateLimit * config.rateSafetyMargin));
  return Math.max(1, Math.floor(effective / 8));
}

/** The pooled budget: one window, shared by every caller without their own key. */
export function createPooledBudgetStore(config: Config): MemoryBudgetStore {
  return new MemoryBudgetStore({
    limit: config.rateLimit,
    windowMs: config.rateWindowMs,
    safetyMargin: config.rateSafetyMargin,
    clientReservation: defaultClientReservation(config),
    newcomerAllowance: config.newcomerAllowance,
    maxTrackedClients: config.maxTrackedClients
  });
}
