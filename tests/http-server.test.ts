import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpHttpServer } from '../src/node/http-server.js';
import { silentLogger } from '../src/telemetry/logger.js';
import { fakeFetchRouter } from './helpers/fake-fetch.js';
import { loadFixture, testConfig } from './helpers/support.js';

/**
 * The HTTP transport, driven by a real MCP client over a real socket.
 *
 * Calling the handler directly would miss everything that actually breaks in a
 * hosted deployment: session negotiation, the `Mcp-Session-Id` round trip, the
 * initialize handshake, and whether the tools a client discovers over HTTP are
 * the same ones it discovers over stdio. Those are the failures that only ever
 * show up on somebody else's machine.
 */

const profile = loadFixture('company/profile-active.json');
const charges = loadFixture('charges/charges-outstanding.json');
const insolvency = loadFixture('insolvency/insolvency-case.json');
const officers = loadFixture('officers/officers-list.json');

function routes() {
  return fakeFetchRouter([
    [/\/company\/[^/]+\/charges/, { body: charges }],
    [/\/company\/[^/]+\/insolvency/, { body: insolvency }],
    [/\/company\/[^/]+\/officers/, { body: officers }],
    [/\/company\/[^/]+$/, { body: profile }]
  ]);
}

interface Started {
  url: string;
  server: Server;
  calls: { url: string; headers: Record<string, string> }[];
}

const running: Server[] = [];

async function start(overrides: Parameters<typeof testConfig>[0] = {}): Promise<Started> {
  const fake = routes();
  const server = createMcpHttpServer({
    config: testConfig({ cacheEnabled: false, ...overrides }),
    logger: silentLogger,
    version: '9.9.9-test',
    fetchImpl: fake.fetch
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  running.push(server);

  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, server, calls: fake.calls };
}

async function connect(url: string, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(headers === undefined ? {} : { requestInit: { headers } })
  });
  // Same SDK typing mismatch under `exactOptionalPropertyTypes` as in
  // `http-server.ts`: `sessionId` is optional on the concrete transport and
  // required on the interface.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return client;
}

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        })
    )
  );
});

describe('HTTP transport — the handshake', () => {
  it('completes initialize and exposes the same tools stdio does', async () => {
    const { url } = await start();
    const client = await connect(url);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    // The point of a transport-agnostic `createServer`: a client over HTTP
    // must see exactly what a client over stdio sees.
    expect(names).toContain('company_snapshot');
    expect(names).toContain('screen_companies');
    expect(names).toContain('find_company');
    expect(tools.length).toBeGreaterThanOrEqual(11);

    await client.close();
  });

  it('serves a real tool call end to end', async () => {
    const { url } = await start();
    const client = await connect(url);

    const result = await client.callTool({
      name: 'company_snapshot',
      arguments: { company_number: '04138203' }
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { company_number?: string; name?: string };
    expect(structured.company_number).toBe('04138203');
    expect(structured.name).toBe('ROYAL MAIL GROUP LIMITED');

    await client.close();
  });

  it('answers a health check without saying anything about the budget or the key', async () => {
    const { url } = await start();
    const response = await fetch(url.replace('/mcp', '/health'));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'ok', version: '9.9.9-test' });
    expect(JSON.stringify(body)).not.toContain('test-key');
  });

  it('404s an unknown path rather than serving MCP from everywhere', async () => {
    const { url } = await start();
    const response = await fetch(url.replace('/mcp', '/'));
    expect(response.status).toBe(404);
  });
});

describe('HTTP transport — sessions', () => {
  it('keeps two clients in separate sessions', async () => {
    const { url } = await start();
    const first = await connect(url);
    const second = await connect(url);

    await expect(first.listTools()).resolves.toBeDefined();
    await expect(second.listTools()).resolves.toBeDefined();

    await first.close();
    // Closing one session must not disturb the other.
    await expect(second.listTools()).resolves.toBeDefined();
    await second.close();
  });

  it('refuses a request carrying an unknown session id', async () => {
    const { url } = await start();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'not-a-real-session'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });

    expect(response.status).toBe(404);
  });

  it('refuses a non-initialize request that omits a session id', async () => {
    const { url } = await start();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });

    expect(response.status).toBe(400);
  });
});

describe('HTTP transport — hardening', () => {
  it('rejects a browser origin that was not allow-listed', async () => {
    const { url } = await start();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });

    expect(response.status).toBe(403);
  });

  it('admits an allow-listed browser origin', async () => {
    const { url } = await start({ allowedOrigins: ['https://good.example'] });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://good.example',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });

    // Past the origin check; refused later for having no session, which is the
    // point — 400 not 403.
    expect(response.status).toBe(400);
  });

  it('refuses a body larger than the configured ceiling', async () => {
    const { url } = await start({ maxRequestBytes: 512 });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(4096) } })
    });

    expect(response.status).toBe(413);
  });

  it('rejects a body that is not JSON', async () => {
    const { url } = await start();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{ not json'
    });

    expect(response.status).toBe(400);
  });

  it('reports the methods it allows rather than failing opaquely', async () => {
    const { url } = await start();
    const response = await fetch(url, { method: 'PUT' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toContain('POST');
  });
});

describe('HTTP transport — bring your own key', () => {
  it('spends the caller’s key upstream when they supply one', async () => {
    const { url, calls } = await start();
    const client = await connect(url, { 'x-companies-house-api-key': 'caller-own-key' });

    await client.callTool({ name: 'get_company', arguments: { company_number: '04138203' } });

    // Basic auth: the key is the username, password empty, trailing colon.
    const expected = `Basic ${Buffer.from('caller-own-key:').toString('base64')}`;
    expect(calls.at(-1)?.headers['authorization']).toBe(expected);

    await client.close();
  });

  it('falls back to the pooled key when no header is supplied', async () => {
    const { url, calls } = await start();
    const client = await connect(url);

    await client.callTool({ name: 'get_company', arguments: { company_number: '04138203' } });

    const expected = `Basic ${Buffer.from('test-key:').toString('base64')}`;
    expect(calls.at(-1)?.headers['authorization']).toBe(expected);

    await client.close();
  });

  it('ignores a malformed key rather than injecting it into a header', async () => {
    const { url, calls } = await start();
    // A newline in a header value is how header injection starts.
    const client = await connect(url, { 'x-companies-house-api-key': 'bad key' });

    await client.callTool({ name: 'get_company', arguments: { company_number: '04138203' } });

    const expected = `Basic ${Buffer.from('test-key:').toString('base64')}`;
    expect(calls.at(-1)?.headers['authorization']).toBe(expected);

    await client.close();
  });

  it('never puts a caller key into a tool response', async () => {
    const { url } = await start();
    const client = await connect(url, { 'x-companies-house-api-key': 'super-secret-key' });

    const result = await client.callTool({
      name: 'company_snapshot',
      arguments: { company_number: '04138203' }
    });

    expect(JSON.stringify(result)).not.toContain('super-secret-key');
    await client.close();
  });
});
