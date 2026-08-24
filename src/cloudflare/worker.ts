import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { systemClock } from '../clock.js';
import type { Config } from '../config.js';
import { ConfigError, loadConfig } from '../config.js';
import { ResponseCache } from '../http/cache.js';
import { CompaniesHouseClient } from '../http/client.js';
import { RateLimiter } from '../http/rate-limiter.js';
import { createLogger } from '../telemetry/logger.js';
import { fingerprint, NoAuthProvider } from '../transport/identity.js';
import type { AuthProvider } from '../transport/identity.js';
import { createSession, defaultClientReservation } from '../transport/sessions.js';
import { BudgetDurableObject } from './budget-do.js';
import { DurableObjectBudgetStore } from './do-budget-store.js';
import { KvCacheStore } from './kv-cache-store.js';
import type { DurableObjectState, ExecutionContext, WorkerEnv } from './types.js';

/**
 * Cloudflare Workers entry point.
 *
 * Deliberately stateless: `sessionIdGenerator` is left undefined, so every
 * request builds a server, answers, and is discarded. That is not a compromise
 * here — it is the only honest option. A Worker isolate is evicted whenever
 * the platform feels like it, so a session held in isolate memory would work
 * in testing and vanish under load. Every tool on this server is
 * request/response with no server-initiated notifications, so there is nothing
 * a session was buying.
 *
 * What is *not* stateless is the part that must not be: the rate-limit window
 * lives in a Durable Object, and the response cache lives in KV. Those are
 * shared across every isolate, which is the whole point. See ADR 12 and 14.
 *
 * Note the subrequest ceiling. A `screen_companies` run over fifty companies
 * makes roughly 150 calls to Companies House in a single invocation, and the
 * Workers free plan allows 50 external subrequests per invocation. This
 * requires the Workers Paid plan; `wrangler.toml` raises the limit explicitly
 * rather than relying on the default.
 */

const MCP_PATH = '/mcp';
const HEALTH_PATH = '/health';

/** The pooled key's window. Named by fingerprint: Durable Object names are not secret. */
function budgetName(apiKey: string): string {
  return `key-${fingerprint(apiKey)}`;
}

export interface WorkerDependencies {
  authProvider?: AuthProvider;
  fetchImpl?: typeof fetch;
  version?: string;
}

export function createFetchHandler(deps: WorkerDependencies = {}) {
  return async function fetchHandler(
    request: Request,
    env: WorkerEnv,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const version = deps.version ?? '0.0.0';

    if (url.pathname === HEALTH_PATH) {
      return json({ status: 'ok', version });
    }

    if (url.pathname !== MCP_PATH) {
      return json(jsonRpcError(-32601, `No such endpoint. The MCP endpoint is ${MCP_PATH}.`), 404);
    }

    let config: Config;
    try {
      config = loadConfig(env as NodeJS.ProcessEnv);
    } catch (error) {
      // The detail goes to the operator's logs, not down the wire. Whoever is
      // calling this endpoint is unauthenticated, and which of our environment
      // variables is misconfigured is none of their business.
      const detail = error instanceof ConfigError ? error.message : String(error);
      console.error(`configuration is invalid: ${detail}`);
      return json(jsonRpcError(-32603, 'The server is misconfigured.'), 500);
    }

    if (env.RATE_LIMIT === undefined) {
      console.error('the RATE_LIMIT Durable Object binding is missing; see wrangler.toml');
      return json(jsonRpcError(-32603, 'The server is misconfigured.'), 500);
    }

    const logger = createLogger({ level: config.logLevel });
    const clock = systemClock;

    if (!originAllowed(request, config.allowedOrigins)) {
      return json(jsonRpcError(-32600, 'Origin not allowed.'), 403);
    }

    const authProvider =
      deps.authProvider ?? new NoAuthProvider({ allowClientKeys: config.allowClientKeys });

    const auth = await authProvider.authenticate({
      header: (name) => request.headers.get(name),
      // Cloudflare sets this and strips any client-supplied copy, so unlike
      // `X-Forwarded-For` it cannot be forged by the caller.
      remoteAddress: request.headers.get('cf-connecting-ip') ?? undefined
    });

    if (!auth.ok) {
      return json(jsonRpcError(-32001, auth.message), auth.status);
    }

    // KV is optional: without it the cache is memory-only, which for a Worker
    // means per-isolate and nearly worthless — but a working server beats a
    // refusing one, and the deployment guide says to bind it.
    const cache = new ResponseCache({
      store:
        env.CACHE === undefined ? undefined : new KvCacheStore({ namespace: env.CACHE, logger }),
      enabled: config.cacheEnabled,
      clock,
      logger
    });

    const namespace = env.RATE_LIMIT;

    const pooledClient = new CompaniesHouseClient({
      config,
      logger,
      clock,
      cache,
      limiter: new RateLimiter({
        clock,
        maxWaitMs: config.maxWaitMs,
        store: new DurableObjectBudgetStore({
          namespace,
          budgetName: budgetName(config.apiKey),
          // The pooled window: shared by strangers, so fair shares apply.
          budgetOptions: {
            limit: config.rateLimit,
            windowMs: config.rateWindowMs,
            safetyMargin: config.rateSafetyMargin,
            clientReservation: defaultClientReservation(config),
            newcomerAllowance: config.newcomerAllowance,
            maxTrackedClients: config.maxTrackedClients
          }
        })
      }),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl })
    });

    const session = createSession(
      {
        config,
        logger,
        clock,
        version,
        cache,
        pooledClient,
        // A caller's own key gets its own Durable Object, and therefore its own
        // window, reached by the same route as the pooled one.
        createBudgetStore: (label) =>
          new DurableObjectBudgetStore({
            namespace,
            budgetName: `client-${label}`,
            // A private window has exactly one caller. Slicing it into shares
            // for callers who by definition cannot reach it would only make it
            // smaller, so `clientReservation` is deliberately left unset.
            budgetOptions: {
              limit: config.rateLimit,
              windowMs: config.rateWindowMs,
              safetyMargin: config.rateSafetyMargin
            }
          }),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl })
      },
      auth.identity
    );

    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless: see the note at the top of this file.
      enableJsonResponse: true
    });

    try {
      await session.server.connect(
        transport as unknown as Parameters<typeof session.server.connect>[0]
      );
      return await transport.handleRequest(request);
    } finally {
      // Nothing survives the request, so nothing may be left holding a socket.
      await session.server.close().catch(() => undefined);
    }
  };
}

export function originAllowed(request: Request, allowed: string[]): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  return allowed.includes(origin);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function jsonRpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/**
 * The deployed Durable Object.
 *
 * Carries no configuration of its own: each operation arrives with the shape
 * of the window it addresses, which is what lets one class back both the
 * pooled budget and every private one. `env` is accepted because the platform
 * passes it, and ignored because there is nothing here to read from it.
 */
export class RateLimitDurableObject extends BudgetDurableObject {
  constructor(state: DurableObjectState, _env: WorkerEnv) {
    super(state);
  }
}

export default { fetch: createFetchHandler() };
