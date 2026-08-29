import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Meta } from '../../src/domain/schemas.js';
import worker from '../../src/cloudflare/worker.js';

/**
 * The Worker, end to end, inside `workerd`.
 *
 * This is the suite that would have caught `Illegal invocation`. Everything
 * here runs in the runtime Cloudflare deploys, against real bindings, with
 * only the Companies House API replaced — so a difference between Node and
 * workerd shows up as a failing test rather than as a broken deployment.
 */

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'workerd-test', version: '1.0.0' }
  }
};

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://worker.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

describe('the Worker in workerd', () => {
  it('answers a health check', async () => {
    const response = await SELF.fetch('https://worker.test/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('completes an initialize handshake', async () => {
    const response = await SELF.fetch(post(INITIALIZE));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      result?: { serverInfo?: { name?: string }; capabilities?: Record<string, unknown> };
    };
    expect(body.result?.serverInfo?.name).toBe('companies-house');
    expect(body.result?.capabilities).toHaveProperty('tools');
  });

  it('issues no session id, because this deployment is stateless', async () => {
    const response = await SELF.fetch(post(INITIALIZE));
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });

  it('calls Companies House and returns the company', async () => {
    // The one that matters. A detached `globalThis.fetch` throws
    // `TypeError: Illegal invocation` here and the tool comes back as a
    // NETWORK_ERROR — which is precisely what the deployed Worker did while
    // every Node test passed.
    const response = await SELF.fetch(
      post({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_company', arguments: { company_number: '04138203' } }
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };

    expect(body.result?.isError).toBeFalsy();
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
      company_number?: string;
      name?: string;
    };
    expect(payload.company_number).toBe('04138203');
    expect(payload.name).toBe('ROYAL MAIL GROUP LIMITED');
  });

  it('refuses GET and DELETE, since there is nothing to stream or delete', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await SELF.fetch(
        new Request('https://worker.test/mcp', { method })
      );
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
  });

  it('rejects a browser origin that was not allow-listed', async () => {
    const response = await SELF.fetch(post(INITIALIZE, { origin: 'https://evil.example' }));
    expect(response.status).toBe(403);
  });

  it('404s a path that is not the MCP endpoint', async () => {
    const response = await SELF.fetch('https://worker.test/');
    expect(response.status).toBe(404);
  });
});

describe('the bindings the deployment declares', () => {
  it('exposes the Durable Object namespace and the KV cache', () => {
    expect(env.RATE_LIMIT).toBeDefined();
    expect(env.CACHE).toBeDefined();
  });
});

/**
 * Reads the tool payload and the meta envelope out of a `tools/call` response.
 *
 * Throws rather than returning undefined on an error result: a test that
 * silently compares two undefineds passes for the wrong reason, and the whole
 * point of this file is to fail when the platform disagrees with us.
 */
interface ToolPayload {
  company_number?: string;
  name?: string;
  meta?: Meta;
}

async function callTool(
  id: number,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<{ payload: ToolPayload; meta: Meta }> {
  const response = await SELF.fetch(
    post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, headers)
  );
  const body = (await response.json()) as {
    result?: { isError?: boolean; content?: { text?: string }[] };
    error?: { message?: string };
  };

  if (body.error !== undefined) throw new Error(`JSON-RPC error: ${body.error.message}`);
  const text = body.result?.content?.[0]?.text ?? '';
  if (body.result?.isError === true) throw new Error(`tool error: ${text}`);

  const payload = JSON.parse(text) as ToolPayload;
  const meta = payload.meta;
  if (meta === undefined) throw new Error(`no meta in tool result: ${text}`);
  return { payload, meta };
}

describe('the KV response cache, across invocations', () => {
  it('serves the second request from KV rather than the network', async () => {
    // The in-memory tier of ResponseCache is built fresh for every request —
    // see the `new ResponseCache(...)` inside `createFetchHandler` — so a hit
    // on a separate invocation cannot have come from anywhere but KV. That
    // makes this a test of the binding, not of the cache class.
    const first = await callTool(10, 'get_company', { company_number: '08888801' });
    expect(first.meta.cached).toBe(false);

    const second = await callTool(11, 'get_company', { company_number: '08888801' });
    expect(second.meta.cached).toBe(true);
    expect(second.meta.age_seconds).toBeTypeOf('number');
    expect(second.payload.name).toBe(first.payload.name);
  });

  it('does not spend budget on an answer it did not fetch', async () => {
    await callTool(12, 'get_company', { company_number: '08888802' });
    const cached = await callTool(13, 'get_company', { company_number: '08888802' });
    const again = await callTool(14, 'get_company', { company_number: '08888802' });

    expect(cached.meta.cached).toBe(true);
    expect(again.meta.cached).toBe(true);
    expect(again.meta.rate_limit_remaining).toBe(cached.meta.rate_limit_remaining);
  });
});

describe('the Durable Object rate-limit window, across invocations', () => {
  it('carries the window between requests instead of restarting it', async () => {
    // Distinct company numbers so every call is a real fetch: a cached answer
    // spends nothing, which would make this pass without a working window.
    const first = await callTool(20, 'get_company', { company_number: '08888810' });
    const second = await callTool(21, 'get_company', { company_number: '08888811' });
    const third = await callTool(22, 'get_company', { company_number: '08888812' });

    const remaining = [first, second, third].map((r) => r.meta.rate_limit_remaining);
    for (const value of remaining) {
      expect(value).toBeGreaterThan(0);
      // 600 requests per window less the 5% safety margin.
      expect(value).toBeLessThanOrEqual(570);
    }
    expect(remaining[1]).toBeLessThan(remaining[0]!);
    expect(remaining[2]!).toBeLessThan(remaining[1]!);
  });

  it('gives a caller who brings their own key a window of their own', async () => {
    // The pooled window has already been drawn on by the tests above. A
    // private window is a different Durable Object, so it must not have been.
    const pooled = await callTool(30, 'get_company', { company_number: '08888820' });
    const own = await callTool(
      31,
      'get_company',
      { company_number: '08888821' },
      { 'x-companies-house-api-key': 'a-caller-supplied-key' }
    );

    expect(own.meta.rate_limit_remaining).toBeGreaterThan(pooled.meta.rate_limit_remaining);
  });
});

describe('the Analytics Engine binding, in the real runtime', () => {
  it('is bound, so the deployment config and the code agree', () => {
    expect(env.ANALYTICS).toBeDefined();
  });

  it('accepts a request with the dataset bound, and still answers it', async () => {
    // What this can and cannot prove is worth being precise about. Miniflare's
    // Analytics Engine binding is `writeDataPoint(_event) {}` — a no-op stub —
    // so nothing here can assert *what* was written; those assertions live in
    // tests/metrics.test.ts and tests/cloudflare.test.ts, against a recording
    // sink under Node. What this proves is the half those cannot: that a real
    // `writeDataPoint` on a real binding accepts the shape we send, in the
    // runtime that will run it, without taking the response down with it.
    const response = await SELF.fetch(
      post({
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/call',
        params: { name: 'get_company', arguments: { company_number: '08888830' } }
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { isError?: boolean } };
    expect(body.result?.isError).toBeFalsy();
  });
});

describe('the scheduled run, in the real runtime', () => {
  it('completes against real bindings without throwing', async () => {
    // Nobody watches a Cron Trigger. An exception here would be invisible
    // until somebody noticed the alerts had never arrived, which is the
    // failure mode alerting exists to prevent.
    const controller = createScheduledController({ cron: '*/5 * * * *' });
    const ctx = createExecutionContext();

    await expect(worker.scheduled(controller, env, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });

  it('spends no budget, so watching the window does not drain it', async () => {
    // The check runs 288 times a day. If it took a slot each time it would
    // consume half the effective window doing nothing but looking at it.
    const before = await callTool(50, 'get_company', { company_number: '08888840' });

    const ctx = createExecutionContext();
    for (let run = 0; run < 3; run += 1) {
      await worker.scheduled(createScheduledController({ cron: '*/5 * * * *' }), env, ctx);
    }
    await waitOnExecutionContext(ctx);

    const after = await callTool(51, 'get_company', { company_number: '08888841' });
    // One request apart, which is the second `get_company` and nothing else.
    expect(after.meta.rate_limit_remaining).toBe(before.meta.rate_limit_remaining - 1);
  });
});
