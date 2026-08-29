import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import packageJson from '../../package.json' with { type: 'json' };

import { systemClock } from '../clock.js';
import type { Config } from '../config.js';
import { ConfigError, loadConfig } from '../config.js';
import { ResponseCache } from '../http/cache.js';
import { CompaniesHouseClient } from '../http/client.js';
import { RateLimiter, SERVER_MAX_WAIT_MS } from '../http/rate-limiter.js';
import { createLogger } from '../telemetry/logger.js';
import { createRequestMetrics } from '../telemetry/metrics.js';
import { RECORDABLE_ERROR_CODES, RECORDABLE_TOOLS } from '../telemetry/recordable.js';
import type { MetricsRecorder, MetricsSink } from '../telemetry/metrics.js';
import { fingerprint, NoAuthProvider } from '../transport/identity.js';
import type { AuthProvider } from '../transport/identity.js';
import { createSession, defaultClientReservation } from '../transport/sessions.js';
import { BudgetDurableObject } from './budget-do.js';
import { alertEndpoint, decideAlert, INITIAL_ALERT_STATE, isAlertState, sendAlert } from './alerts.js';
import type { AlertState } from './alerts.js';
import { AnalyticsEngineSink } from './analytics-metrics.js';
import { DurableObjectBudgetStore } from './do-budget-store.js';
import { KvCacheStore } from './kv-cache-store.js';
import type {
  DurableObjectState,
  ExecutionContext,
  ScheduledController,
  WorkerEnv
} from './types.js';

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

/**
 * Inlined at build time by the bundler. Kept as a module-level import rather
 * than a hand-maintained constant so it cannot drift from the published
 * version — the same argument `version.ts` makes for reading it at runtime on
 * Node.
 */
const WORKER_VERSION: string = packageJson.version;

/**
 * What this deployment may write into an analytics label.
 *
 * Derived from the real registries, so the set cannot drift from the tools
 * that exist. See src/telemetry/recordable.ts.
 */
const RECORDABLE = { tools: RECORDABLE_TOOLS, errorCodes: RECORDABLE_ERROR_CODES };

const MCP_PATH = '/mcp';
const HEALTH_PATH = '/health';

/** The pooled key's window. Named by fingerprint: Durable Object names are not secret. */
function budgetName(apiKey: string): string {
  return `key-${fingerprint(apiKey)}`;
}

export interface WorkerDependencies {
  authProvider?: AuthProvider;
  fetchImpl?: typeof fetch;
  /** Defaults to the package version, inlined at build time. */
  version?: string;
  /**
   * Where finished requests are written. Defaults to the Analytics Engine
   * dataset when one is bound, and to nothing when it is not.
   *
   * Injectable because Miniflare's Analytics Engine binding is a no-op stub:
   * a test in `workerd` can prove a data point was accepted but never what was
   * in it, so every assertion about column layout runs under Node against a
   * recording sink instead. See tests/cloudflare.test.ts.
   */
  metricsSink?: MetricsSink;
}

export function createFetchHandler(deps: WorkerDependencies = {}) {
  return async function fetchHandler(
    request: Request,
    env: WorkerEnv,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const version = deps.version ?? WORKER_VERSION;

    if (url.pathname === HEALTH_PATH) {
      return json({ status: 'ok', version });
    }

    if (url.pathname !== MCP_PATH) {
      return json(jsonRpcError(-32601, `No such endpoint. The MCP endpoint is ${MCP_PATH}.`), 404);
    }

    // Answered before anything is built. This deployment is stateless — see
    // the note at the top — so there are no server-initiated notifications to
    // stream and no session to delete. Letting a GET through opened a
    // standalone SSE stream that the `finally` below then tore down before the
    // response left, so a client that opens the notification stream after
    // initialize would reconnect in a loop, paying a full config parse, auth
    // and Durable Object wiring on every attempt.
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify(jsonRpcError(-32600, 'This endpoint is stateless; only POST is supported.')),
        { status: 405, headers: { 'content-type': 'application/json', allow: 'POST' } }
      );
    }

    // Below the routing checks on purpose: a health probe and a wrong-path 404
    // are noise, and a row for each would bury the requests that matter.
    const startedAt = Date.now();
    // One recorder per invocation, and therefore one row per request — not one
    // per upstream call. The platform accepts 250 `writeDataPoint` calls per
    // invocation and a fifty-company screen makes roughly 150 upstream
    // requests, so per-call writes would start dropping exactly the runs an
    // operator most wants to see. See ./analytics-metrics.ts.
    const metrics = createRequestMetrics(RECORDABLE);
    const sink =
      deps.metricsSink ??
      (env.ANALYTICS === undefined
        ? undefined
        : new AnalyticsEngineSink({
            dataset: env.ANALYTICS,
            version,
            onError: (error) => {
              console.error(`analytics write failed: ${String(error)}`);
            }
          }));

    try {
      const response = await handleMcp({ request, env, version, metrics, deps });
      await recordTransportFailure(response, metrics);
      return response;
    } catch (error) {
      // An escaping throw is a bug in this server, and it used to flush a row
      // saying `ok` on its way out — the single most misleading thing the
      // dataset could contain.
      metrics.failed('internal_error');
      throw error;
    } finally {
      // Written whatever happened, refusals included. A deployment turning
      // callers away is precisely the one that needs a row, and measuring only
      // the happy path would hide every problem worth alerting on.
      //
      // Guarded here rather than only inside the sink: this runs in a
      // `finally` after the answer is built, so anything thrown replaces a
      // good response with a 500. That defence has to hold for every sink,
      // not only the one that happens to catch its own errors today.
      try {
        sink?.write(metrics.snapshot(Date.now() - startedAt));
      } catch (error) {
        console.error(`metrics flush failed: ${String(error)}`);
      }
    }
  };
}

/**
 * Counts the failures the MCP SDK answers on our behalf.
 *
 * `guard` only wraps tool handlers, and the SDK rejects a malformed body, an
 * unknown method, an unknown tool name and invalid arguments *above* it — as
 * ordinary JSON-RPC error responses, not as exceptions. Nothing downstream
 * ever saw them, so a client sending garbage in a loop was indistinguishable
 * from healthy traffic in the one column an operator alerts on.
 *
 * Only inspected when the recorder still says the request succeeded and no
 * tool was ever named, which is precisely the set of requests the SDK can
 * have rejected. A successful `tools/call` has a tool, so its body — which for
 * a fifty-company screen is large — is never parsed.
 *
 * Never throws. This runs after a good answer has been built.
 */
async function recordTransportFailure(
  response: Response,
  metrics: MetricsRecorder
): Promise<void> {
  try {
    const snapshot = metrics.snapshot(0);
    if (snapshot.outcome !== 'ok' || snapshot.tool !== 'unknown') return;

    const body: unknown = await response.clone().json();
    const failed = (message: unknown): boolean => {
      if (typeof message !== 'object' || message === null) return false;
      const record = message as { error?: unknown; result?: { isError?: unknown } };
      return record.error !== undefined || record.result?.isError === true;
    };

    // A batch answers with an array; one bad member makes the request a
    // failure, since the caller did not get what they asked for.
    const anyFailed = Array.isArray(body) ? body.some(failed) : failed(body);
    if (anyFailed) metrics.failed('protocol_error');
  } catch {
    // A body that will not parse is not worth failing a request over, and the
    // response itself has already gone out unchanged.
  }
}

interface McpRequest {
  request: Request;
  env: WorkerEnv;
  version: string;
  metrics: MetricsRecorder;
  deps: WorkerDependencies;
}

/**
 * One MCP request, from configuration through to the transport.
 *
 * Split out from the routing above so that every exit path — a bad config, a
 * rejected origin, a refused credential, a normal answer — passes through the
 * caller's `finally` and is counted. Instrumentation that covers only the
 * happy path measures the half of the system that was never in doubt.
 */
async function handleMcp({ request, env, version, metrics, deps }: McpRequest): Promise<Response> {
  let config: Config;
  try {
    config = loadConfig(env as NodeJS.ProcessEnv);
  } catch (error) {
    // The detail goes to the operator's logs, not down the wire. Whoever is
    // calling this endpoint is unauthenticated, and which of our environment
    // variables is misconfigured is none of their business.
    const detail = error instanceof ConfigError ? error.message : String(error);
    console.error(`configuration is invalid: ${detail}`);
    metrics.failed('misconfigured');
    return json(jsonRpcError(-32603, 'The server is misconfigured.'), 500);
  }

  if (env.RATE_LIMIT === undefined) {
    console.error('the RATE_LIMIT Durable Object binding is missing; see wrangler.toml');
    metrics.failed('misconfigured');
    return json(jsonRpcError(-32603, 'The server is misconfigured.'), 500);
  }

  const logger = createLogger({ level: config.logLevel });
  const clock = systemClock;

  if (!originAllowed(request, config.allowedOrigins)) {
    metrics.failed('origin_rejected');
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
    metrics.failed('unauthorised');
    // Relayed, not dropped: a 401 without it leaves an MCP client with
    // nothing to discover. `NoAuthProvider` never fails, so this is latent
    // today — but the injected provider is the whole point of the seam in
    // ADR 15, and the Node entry point already does this.
    return new Response(JSON.stringify(jsonRpcError(-32001, auth.message)), {
      status: auth.status,
      headers: {
        'content-type': 'application/json',
        ...(auth.wwwAuthenticate === undefined
          ? {}
          : { 'www-authenticate': auth.wwwAuthenticate })
      }
    });
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
      maxWaitMs: config.maxWaitMs ?? SERVER_MAX_WAIT_MS,
      // Handed over directly for the same reason as the limits below: this
      // limiter is constructed here rather than by the client, so it inherits
      // nothing. Without it the pooled path — which is the deployed one —
      // records no budget readings and no refusals at all.
      metrics,
      // Passed explicitly: without them the limiter falls back to the
      // documented defaults for its reported ceiling, and a deployment that
      // set CH_RATE_LIMIT would be told a number that was never true.
      limit: config.rateLimit,
      safetyMargin: config.rateSafetyMargin,
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
    metrics,
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
      metrics,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl })
    },
    auth.identity
  );

  // Read from the outcome, not from the header: a caller who supplies this
  // deployment's own key is routed into the pool and gets no window of their
  // own, so counting the header would overstate it.
  if (session.ownsBudget) metrics.ownKey();

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


/**
 * Where the alerting state lives between scheduled runs.
 *
 * Shares the response cache's namespace rather than asking for a second one:
 * cache keys are SHA-256 hex, so a prefixed literal cannot collide with one,
 * and requiring another binding to get alerting would mean most deployments
 * never turn it on.
 */
const ALERT_STATE_KEY = 'ch-mcp:alert-state';

export interface ScheduledDependencies {
  fetchImpl?: typeof fetch;
  version?: string;
  metricsSink?: MetricsSink;
  /** Injectable so tests do not have to wait for a real clock. */
  now?: () => number;
}

/**
 * The Cron Trigger: check the window, alert if it is in trouble, leave a mark.
 *
 * It reads the Durable Object directly. The alternative — querying the
 * Analytics Engine SQL API — would need an account-scoped API token stored in
 * a Worker that anybody on the internet can reach, which is a poor trade for
 * a number the deployment already holds authoritatively.
 *
 * The heartbeat matters as much as the alert. Without it the dataset only has
 * rows when somebody called, so a quiet period and an outage look identical,
 * and the budget cannot be charted over time.
 */
export function createScheduledHandler(deps: ScheduledDependencies = {}) {
  return async function scheduledHandler(
    _controller: ScheduledController,
    env: WorkerEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    const version = deps.version ?? WORKER_VERSION;
    const now = deps.now ?? (() => Date.now());
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

    let config: Config;
    try {
      config = loadConfig(env as NodeJS.ProcessEnv);
    } catch (error) {
      const detail = error instanceof ConfigError ? error.message : String(error);
      console.error(`scheduled check skipped, configuration is invalid: ${detail}`);
      return;
    }

    if (env.RATE_LIMIT === undefined) {
      console.error('scheduled check skipped: the RATE_LIMIT binding is missing');
      return;
    }

    const store = new DurableObjectBudgetStore({
      namespace: env.RATE_LIMIT,
      budgetName: budgetName(config.apiKey),
      budgetOptions: {
        limit: config.rateLimit,
        windowMs: config.rateWindowMs,
        safetyMargin: config.rateSafetyMargin,
        clientReservation: defaultClientReservation(config),
        newcomerAllowance: config.newcomerAllowance,
        maxTrackedClients: config.maxTrackedClients
      }
    });

    // `peek`, never `acquire`: watching the budget must not spend any of it.
    // A check every five minutes that took a slot would consume 288 requests a
    // day of the very allowance it exists to protect.
    //
    // Read under a client id of its own, so the figure is what an arriving
    // caller would be allowed right now rather than the raw global remainder.
    // That is the number worth alerting on — it answers "is the next person
    // through the door going to be refused" — and since a share is bounded by
    // what is globally available, it can only fall near zero when the window
    // genuinely is. `peek` records nothing, so this does not itself count as a
    // caller or inflate anybody else's crowd.
    const reading = await store.peek('scheduled-check', now());

    const metrics = createRequestMetrics(RECORDABLE);
    metrics.tool('heartbeat');
    if (reading.boundBy === 'unavailable') {
      // Recorded as an error, not a refusal: the check uses `peek` and turns
      // nobody away, and a synthetic `refused` row every five minutes pollutes
      // the one query an operator uses to count callers who were. The budget
      // columns are left at their "never observed" sentinel rather than
      // plotting a coordinator outage as the window collapsing to zero.
      metrics.failed('UPSTREAM_UNAVAILABLE');
    } else {
      // The window, not this synthetic caller's share of it. The share is
      // floored at a reservation and would chart as a flat line.
      metrics.budget(reading.globalRemaining, reading.limit);
    }

    const sink =
      deps.metricsSink ??
      (env.ANALYTICS === undefined
        ? undefined
        : new AnalyticsEngineSink({ dataset: env.ANALYTICS, version }));
    try {
      sink?.write(metrics.snapshot(0));
    } catch (error) {
      console.error(`heartbeat write failed: ${String(error)}`);
    }

    const configured =
      typeof env['CH_ALERT_WEBHOOK_URL'] === 'string' ? env['CH_ALERT_WEBHOOK_URL'] : undefined;
    const endpoint = alertEndpoint(configured);

    // Both of these say so out loud. An operator who has set a webhook
    // believes alerting is on, and silently declining to send would leave
    // them trusting a channel that will never fire — which is the failure
    // this whole check exists to prevent, reproduced one level up.
    //
    // The rejected value is never echoed: it is a capability URL and a
    // secret, and a log line is the wrong place for it.
    if (configured !== undefined && configured.trim() !== '' && endpoint === undefined) {
      console.error(
        'CH_ALERT_WEBHOOK_URL is set but is not a usable https URL; no alerts will be sent'
      );
      return;
    }
    if (endpoint === undefined) return;

    // Without KV there is nowhere to keep a strike count, so the hysteresis
    // that stops this crying wolf cannot work. Refusing to alert is the honest
    // answer: alerting that fires on every blip gets muted, and a muted
    // channel is worse than none because it is still believed to work.
    if (env.CACHE === undefined) {
      console.error(
        'CH_ALERT_WEBHOOK_URL is set but the CACHE binding is missing, so alert state cannot be kept; no alerts will be sent'
      );
      return;
    }

    const previous = await readAlertState(env.CACHE);
    const decision = decideAlert(previous, reading, now());

    // Sent before the state is committed, and the state records what actually
    // arrived. Persisting `firing: true` first meant a webhook that was down
    // for a single check swallowed the whole incident: the next run saw
    // `firing` and stayed quiet, and the operator eventually received a
    // "resolved" for an alert they had never been sent.
    let state = decision.state;
    if (decision.payload !== undefined) {
      const delivered = await sendAlert({ url: endpoint, payload: decision.payload, fetchImpl });
      if (!delivered) {
        console.error('alert webhook did not accept the message; will retry on the next check');
        // The previous state, unchanged — not a patched version of the new
        // one. Nothing was communicated, so nothing should be remembered as
        // communicated, and recomputing from the same starting point next
        // check retries whichever message this was. Forcing `firing: false`
        // instead only retried the firing direction: a failed `resolved`
        // landed on a state that was already reset, so the recovery was
        // dropped for good and the operator kept an incident open forever.
        state = previous;
      }
    }

    try {
      await env.CACHE.put(ALERT_STATE_KEY, JSON.stringify(state));
    } catch (error) {
      console.error(`alert state write failed: ${String(error)}`);
    }
  };
}

async function readAlertState(cache: NonNullable<WorkerEnv['CACHE']>): Promise<AlertState> {
  try {
    const raw = await cache.get(ALERT_STATE_KEY, 'text');
    if (raw === null) return { ...INITIAL_ALERT_STATE };
    const parsed: unknown = JSON.parse(raw);
    // A stored value that is not a state is treated as absent rather than
    // trusted: a malformed `strikes` would otherwise latch the alerting
    // permanently on or permanently off.
    if (isAlertState(parsed)) return parsed;
    console.error('stored alert state was unreadable and has been reset');
    return { ...INITIAL_ALERT_STATE };
  } catch (error) {
    // Said out loud. This was the only failure path here with no log at all,
    // and it disables alerting completely — the strike count resets on every
    // run, so nothing can ever reach the bound.
    console.error(`alert state read failed, starting from scratch: ${String(error)}`);
    return { ...INITIAL_ALERT_STATE };
  }
}

/**
 * The deployed handlers.
 *
 * The version defaults inside each factory rather than being passed here, so
 * that every caller gets it right rather than only this one.
 */
export default { fetch: createFetchHandler(), scheduled: createScheduledHandler() };
