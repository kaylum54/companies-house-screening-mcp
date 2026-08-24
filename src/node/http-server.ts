import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';
import type { Config } from '../config.js';
import type { BudgetStore } from '../http/budget-store.js';
import { MemoryBudgetStore } from '../http/budget-store.js';
import { ResponseCache } from '../http/cache.js';
import { CompaniesHouseClient } from '../http/client.js';
import { RateLimiter } from '../http/rate-limiter.js';
import type { Logger } from '../telemetry/logger.js';
import type { AuthProvider, ClientIdentity } from '../transport/identity.js';
import { describe, NoAuthProvider } from '../transport/identity.js';
import type { Session } from '../transport/sessions.js';
import { createPooledBudgetStore, createSession } from '../transport/sessions.js';
import type { CacheStore } from '../http/cache-store.js';

/**
 * Streamable HTTP entry point.
 *
 * This is what makes the server reachable by clients that cannot spawn a
 * process — claude.ai on web and mobile, hosted agent platforms, anything
 * running somewhere other than the user's laptop. stdio remains untouched and
 * remains the right answer for a local install; this is additive. See ADR 12.
 *
 * `createServer` in `server.ts` never learned that any of this exists: it
 * builds an `McpServer` and registers tools, and the transport is bolted on by
 * whoever is doing the bolting. That was already true before this file, which
 * is why adding it was small.
 */

export interface HttpServerOptions {
  config: Config;
  logger: Logger;
  version: string;
  clock?: Clock;
  /** Durable cache tier. Shared by every session. */
  cacheStore?: CacheStore | undefined;
  /** Defaults to `NoAuthProvider`: admits everyone, still tells them apart. */
  authProvider?: AuthProvider;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface RunningHttpServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const MCP_PATH = '/mcp';
/** How often the idle sweep may actually run, however many requests arrive. */
const SWEEP_INTERVAL_MS = 30_000;
const HEALTH_PATH = '/health';
const SESSION_HEADER = 'mcp-session-id';

export function createMcpHttpServer(options: HttpServerOptions): Server {
  const { config, logger, version } = options;
  const clock = options.clock ?? systemClock;
  const authProvider = options.authProvider ?? new NoAuthProvider({ allowClientKeys: config.allowClientKeys });

  // One cache and one pooled window for the whole process, which is the point.
  const cache = new ResponseCache({
    store: options.cacheStore,
    enabled: config.cacheEnabled,
    clock,
    logger
  });

  const pooledClient = new CompaniesHouseClient({
    config,
    logger,
    clock,
    cache,
    limiter: new RateLimiter({
      clock,
      maxWaitMs: config.maxWaitMs,
      store: createPooledBudgetStore(config)
    }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });

  /**
   * Private windows, one per credential — keyed, not created per session.
   *
   * Creating one per session would mean a caller reconnecting between calls
   * got a fresh 570 requests every time, which is not a rate limiter. The key
   * is the caller's identity fingerprint, matching how Cloudflare names the
   * Durable Object for the same caller so the two runtimes agree.
   */
  const privateBudgets = new Map<
    string,
    { store: MemoryBudgetStore; lastSeen: number; refs: number }
  >();

  /**
   * Wraps a private budget so that *using* it counts as activity.
   *
   * Without this, `lastSeen` was only set when a session was created, so a
   * heavily-used private window aged exactly as fast as an abandoned one. Being
   * evicted mid-use is not a small matter: the caller's next reconnect builds a
   * fresh full window on a credential that already has one, and Companies House
   * meters the credential, so that key is then being spent against two local
   * windows at once.
   */
  function trackUsage(label: string, store: MemoryBudgetStore): BudgetStore {
    const touchBudget = (): void => {
      const entry = privateBudgets.get(label);
      if (entry !== undefined) entry.lastSeen = clock.now();
    };

    return {
      acquire: async (clientId, now) => {
        touchBudget();
        return store.acquire(clientId, now);
      },
      peek: async (clientId, now) => {
        touchBudget();
        return store.peek(clientId, now);
      },
      penalise: async (resetAtMs) => store.penalise(resetAtMs),
      observe: async (hint) => store.observe(hint)
    };
  }

  /**
   * Bounded for the same reason `sessions` is: the key is caller-supplied, the
   * endpoint is authless, and rotating fabricated keys would otherwise grow
   * this map for the life of the process. With `trackUsage` above, the entry
   * evicted is genuinely the least recently *used* rather than merely the
   * least recently created.
   */
  function rememberPrivateBudget(label: string, store: MemoryBudgetStore): void {
    privateBudgets.set(label, { store, lastSeen: clock.now(), refs: 1 });
    if (privateBudgets.size <= config.maxSessions) return;

    // Only budgets with no live session are candidates. Evicting one that a
    // session still holds does not free it — the session keeps the orphaned
    // store — and the caller's next reconnect then builds a *second* full
    // window on the same credential, so one Companies House key ends up
    // metered against two local windows. That is worse than the unbounded map
    // this cap exists to prevent, and the map stays bounded anyway: every
    // referenced budget belongs to a live session, and sessions are themselves
    // capped at `maxSessions`.
    let oldestLabel: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of privateBudgets) {
      if (entry.refs > 0) continue;
      if (entry.lastSeen < oldest) {
        oldest = entry.lastSeen;
        oldestLabel = key;
      }
    }
    if (oldestLabel !== undefined) privateBudgets.delete(oldestLabel);
  }

  /** Called when a session ends, so its private budget becomes evictable. */
  function releasePrivateBudget(label: string | undefined): void {
    if (label === undefined) return;
    const entry = privateBudgets.get(label);
    if (entry === undefined) return;
    entry.refs = Math.max(entry.refs - 1, 0);
    entry.lastSeen = clock.now();
  }

  const sessionFactory = {
    config,
    logger,
    clock,
    version,
    cache,
    pooledClient,
    createBudgetStore: (label: string): BudgetStore => {
      const existing = privateBudgets.get(label);
      if (existing !== undefined) {
        existing.lastSeen = clock.now();
        existing.refs += 1;
        return trackUsage(label, existing.store);
      }
      const created = new MemoryBudgetStore({
        limit: config.rateLimit,
        windowMs: config.rateWindowMs,
        safetyMargin: config.rateSafetyMargin
      });
      rememberPrivateBudget(label, created);
      return trackUsage(label, created);
    },
    fetchImpl: options.fetchImpl
  };

  interface Registered {
    transport: StreamableHTTPServerTransport;
    session: Session;
    lastSeen: number;
    /** Private budget this session holds a reference to, if any. */
    budgetLabel: string | undefined;
  }

  /**
   * Open sessions.
   *
   * Bounded in two directions, because opening one costs nothing and anybody
   * can: idle sessions are swept, and the oldest is evicted once the cap is
   * reached. Without either, a stream of `initialize` posts retains an
   * `McpServer` and a transport apiece for the life of the process.
   */
  const sessions = new Map<string, Registered>();

  function touch(id: string): void {
    const entry = sessions.get(id);
    if (entry !== undefined) entry.lastSeen = clock.now();
  }

  function drop(id: string): void {
    const entry = sessions.get(id);
    if (entry === undefined) return;
    sessions.delete(id);
    releasePrivateBudget(entry.budgetLabel);
    void entry.session.server.close().catch(() => undefined);
  }

  let lastSweep = 0;

  /**
   * Sweeping was previously driven only by a new client initializing, which
   * meant idle sessions were reclaimed exactly when the server was busy and
   * never when it was quiet — the opposite of what the setting promises. It
   * now runs on any request, throttled so a busy server is not walking the
   * map on every one, and without a timer that would keep the process alive.
   */
  function maybeSweep(): void {
    const now = clock.now();
    if (now - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = now;
    sweep();
  }

  function sweep(): void {
    const cutoff = clock.now() - config.sessionIdleMs;
    for (const [id, entry] of sessions) {
      if (entry.lastSeen <= cutoff) {
        logger.info('session expired', { sessionId: id });
        drop(id);
      }
    }

    // Still over the cap after sweeping: evict least recently used until under.
    while (sessions.size > config.maxSessions) {
      let oldestId: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, entry] of sessions) {
        if (entry.lastSeen < oldest) {
          oldest = entry.lastSeen;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      logger.warn('session evicted: too many open sessions', { sessionId: oldestId });
      drop(oldestId);
    }
  }

  const http = createHttpServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      logger.error('unhandled error serving request', { error });
      if (!res.headersSent) sendJson(res, 500, jsonRpcError(-32603, 'Internal server error'));
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    maybeSweep();

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === HEALTH_PATH) {
      // Deliberately says nothing about the budget or the key. A health check
      // is reachable by anyone who can reach the port.
      sendJson(res, 200, { status: 'ok', version });
      return;
    }

    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, jsonRpcError(-32601, `No such endpoint. The MCP endpoint is ${MCP_PATH}.`));
      return;
    }

    if (!originAllowed(req, config.allowedOrigins)) {
      // Browser-initiated cross-origin requests are refused outright. MCP
      // clients are not browsers and send no Origin header, so this costs
      // real callers nothing while closing DNS-rebinding attacks against a
      // server that is often bound to loopback.
      logger.warn('rejected request with disallowed origin', { origin: req.headers.origin });
      sendJson(res, 403, jsonRpcError(-32600, 'Origin not allowed.'));
      return;
    }

    const sessionId = headerValue(req, SESSION_HEADER);

    if (req.method === 'GET' || req.method === 'DELETE') {
      const existing = sessionId === undefined ? undefined : sessions.get(sessionId);
      if (existing === undefined) {
        sendJson(res, 404, jsonRpcError(-32001, 'Unknown or expired session.'));
        return;
      }
      touch(sessionId as string);
      await existing.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST, DELETE');
      sendJson(res, 405, jsonRpcError(-32600, 'Method not allowed.'));
      return;
    }

    const declared = Number(headerValue(req, 'content-length') ?? '');
    if (Number.isFinite(declared) && declared > config.maxRequestBytes) {
      // Answered from the header, before reading a byte. This is the path a
      // real client takes, and it gets a clean 413 rather than a reset socket.
      sendJson(res, 413, jsonRpcError(-32600, 'Request body too large.'));
      return;
    }

    const body = await readBody(req, config.maxRequestBytes);
    if (body.tooLarge) {
      sendJson(res, 413, jsonRpcError(-32600, 'Request body too large.'));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      sendJson(res, 400, jsonRpcError(-32700, 'Parse error: body is not valid JSON.'));
      return;
    }

    if (sessionId !== undefined) {
      const existing = sessions.get(sessionId);
      if (existing === undefined) {
        sendJson(res, 404, jsonRpcError(-32001, 'Unknown or expired session.'));
        return;
      }
      touch(sessionId);
      await existing.transport.handleRequest(req, res, parsed);
      return;
    }

    if (!isInitializeRequest(parsed)) {
      sendJson(res, 400, jsonRpcError(-32000, 'Missing Mcp-Session-Id; only initialize may omit it.'));
      return;
    }

    // Identity is resolved once, at initialize, and bound to the session for
    // its lifetime. A caller bringing their own key must therefore send the
    // header on the initialize request — which every client that can set
    // headers at all does, since they set them on every request.
    const auth = await authProvider.authenticate({
      header: (name) => headerValue(req, name) ?? null,
      remoteAddress: remoteAddress(req, config.trustProxyHeaders)
    });

    if (!auth.ok) {
      if (auth.wwwAuthenticate !== undefined) res.setHeader('WWW-Authenticate', auth.wwwAuthenticate);
      sendJson(res, auth.status, jsonRpcError(-32001, auth.message));
      return;
    }

    await openSession(req, res, parsed, auth.identity);
  }

  async function openSession(
    req: IncomingMessage,
    res: ServerResponse,
    parsed: unknown,
    identity: ClientIdentity
  ): Promise<void> {
    const session = createSession(sessionFactory, identity);
    // Only a caller spending their own key holds a private budget; anyone on
    // the pooled key shares the one window and has nothing to release.
    const budgetLabel =
      identity.apiKey !== undefined && identity.apiKey !== config.apiKey
        ? identity.clientId
        : undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, session, lastSeen: clock.now(), budgetLabel });
        logger.info('session opened', { sessionId: id, ...describe(identity) });
        sweep();
      },
      onsessionclosed: (id) => {
        releasePrivateBudget(sessions.get(id)?.budgetLabel);
        sessions.delete(id);
        logger.info('session closed', { sessionId: id });
      }
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) sessions.delete(id);
      releasePrivateBudget(budgetLabel);
      void session.server.close().catch(() => undefined);
    };

    // The SDK declares `onclose` as `(() => void) | undefined` on the concrete
    // transport but as `() => void` on the `Transport` interface, which this
    // project's `exactOptionalPropertyTypes` correctly refuses to reconcile.
    // The mismatch is in the SDK's own types, not in this usage — the in-memory
    // transport the test harness uses connects the same way — so it is cast
    // here rather than relaxing a compiler setting for the whole project.
    await session.server.connect(transport as unknown as Parameters<typeof session.server.connect>[0]);
    await transport.handleRequest(req, res, parsed);
  }

  // Attached so the caller can shut sessions down without reaching inside.
  Object.defineProperty(http, 'closeSessions', {
    value: async (): Promise<void> => {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map(({ session }) => session.server.close().catch(() => undefined)));
    }
  });

  return http;
}

/**
 * Origin policy.
 *
 * No Origin header means the caller is not a browser, which is every real MCP
 * client, and is allowed. An Origin header means a browser sent this, and it
 * is allowed only if the operator listed it.
 */
export function originAllowed(req: IncomingMessage, allowed: string[]): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return allowed.includes(origin);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Peer address, used only to partition fair-share budgets — never to
 * authorise. There is no per-caller data on this server to reach.
 *
 * `X-Forwarded-For` is set by the caller and is only consulted when the
 * operator says a trusted proxy is in front. That default matters: a client
 * that varies the header per request would mint a fresh identity each time,
 * and with it a fresh reservation, which defeats fair sharing entirely. Behind
 * a real proxy the socket address is the proxy's and every caller collapses
 * into one identity, so the setting has to exist — it just has to be a
 * decision rather than a default.
 *
 * `CF-Connecting-IP` gets no special treatment here. It is only trustworthy
 * inside Cloudflare's runtime, where the platform sets it and strips any
 * client copy; arriving at a Node process it is just another header the caller
 * typed. The Worker reads it directly from its own request, which is the only
 * place it means anything.
 */
function remoteAddress(req: IncomingMessage, trustProxyHeaders: boolean): string | undefined {
  if (trustProxyHeaders) {
    const forwarded =
      headerValue(req, 'x-forwarded-for') ?? headerValue(req, 'cf-connecting-ip');
    if (forwarded !== undefined && forwarded.trim() !== '') {
      return forwarded.split(',')[0]?.trim();
    }
  }

  return req.socket.remoteAddress ?? undefined;
}

interface BodyResult {
  text: string;
  tooLarge: boolean;
}

/**
 * Reads a request body with a hard ceiling.
 *
 * The ceiling is the point: an endpoint anyone can reach must not let a caller
 * decide how much memory this process allocates. Reading stops the moment the
 * limit is passed rather than buffering the whole thing and measuring after.
 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      // Stop accumulating, but do not tear down the socket: the caller still
      // has to be able to read the 413. Pausing is enough — the response is
      // written immediately after this returns.
      req.pause();
      return { text: '', tooLarge: true };
    }
    chunks.push(buffer);
  }

  return { text: Buffer.concat(chunks).toString('utf8'), tooLarge: false };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function jsonRpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}
