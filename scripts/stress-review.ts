/** Offline MCP pressure/fault probe. No real API calls or credentials. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CompaniesHouseClient } from '../src/http/client.js';
import { RateLimiter } from '../src/http/rate-limiter.js';
import { createServer } from '../src/server.js';
import { silentLogger } from '../src/telemetry/logger.js';
import { loadFixture, testConfig } from '../tests/helpers/support.js';

type Row = Record<string, unknown>;
const numbers = Array.from({ length: 50 }, (_, i) => String(10000000 + i));
const profile = loadFixture<Row>('company/profile-active.json');
const officers = loadFixture('officers/officers-list.json');
const charges = loadFixture('charges/charges-outstanding.json');
const reports: Row[] = [];

async function setup(options: { limit?: number; latency?: number; timeout?: number; fault?: number | 'malformed' } = {}) {
  let calls = 0, active = 0, peak = 0;
  const config = testConfig({ maxRetries: 0, rateLimit: options.limit ?? 10000, timeoutMs: options.timeout ?? 5000 });
  const fetchImpl: typeof fetch = async (input, init) => {
    calls++; active++; peak = Math.max(peak, active);
    try {
      try { await delay(options.latency ?? 2, undefined, { signal: init?.signal ?? undefined }); }
      catch (error) { if (init?.signal?.aborted) throw init.signal.reason; throw error; }
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('/charges') && options.fault !== undefined) {
        return options.fault === 'malformed'
          ? new Response('{bad json', { status: 200 })
          : new Response('{}', { status: options.fault });
      }
      let data: unknown = { ...profile, company_number: url.pathname.split('/')[2] };
      if (url.pathname.endsWith('/officers')) data = officers;
      if (url.pathname.endsWith('/charges')) data = charges;
      if (url.pathname.endsWith('/insolvency')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(data), { status: 200 });
    } finally { active--; }
  };
  const upstream = new CompaniesHouseClient({ config, fetchImpl,
    limiter: new RateLimiter({ limit: config.rateLimit, safetyMargin: 0.95, maxWaitMs: 0, jitterMs: 0 }) });
  const server = createServer({ client: upstream, logger: silentLogger, now: Date.now }, 'stress');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'offline-stress-review', version: '1' });
  await client.connect(ct);
  return { client, stats: () => ({ calls, peak }), close: async () => { await client.close(); await server.close(); } };
}

function body(result: Awaited<ReturnType<Client['callTool']>>) {
  assert.ok(!result.isError, 'MCP returned a tool-level error');
  return result.structuredContent as { requested: number; screened: Row[]; unresolved: Row[]; not_screened: Row[] };
}
function accounted(data: ReturnType<typeof body>) {
  return data.screened.length + data.unresolved.length + data.not_screened.length;
}

for (const { concurrency, distinct } of [
  { concurrency: 1, distinct: false }, { concurrency: 5, distinct: false },
  { concurrency: 20, distinct: false }, { concurrency: 5, distinct: true },
  { concurrency: 20, distinct: true }
]) {
  const h = await setup();
  const started = performance.now();
  try {
    const batches = Array.from({ length: concurrency }, (_, batch) =>
      distinct ? numbers.map((_, i) => String(10000000 + batch * 50 + i)) : numbers);
    const results = await Promise.all(batches.map(companies =>
      h.client.callTool({ name: 'screen_companies', arguments: { companies, include_officers: true } })));
    const data = results.map(body);
    for (const [index, result] of data.entries()) {
      assert.equal(accounted(result), 50);
      assert.equal(result.screened.length, 50);
      assert.deepEqual(result.screened.map(r => r['company_number']), batches[index]);
    }
    assert.ok(h.stats().peak <= 12, 'shared upstream concurrency exceeded 12');
    reports.push({ scenario: '50-company full-section batches', concurrency, distinct, inputs: concurrency * 50,
      ...h.stats(), duration_ms: Math.round(performance.now() - started), passed: true });
  } finally { await h.close(); }
}

for (const fault of [403, 429, 503, 'malformed'] as const) {
  const h = await setup({ fault });
  try {
    const result = body(await h.client.callTool({ name: 'screen_companies', arguments: { companies: numbers } }));
    assert.equal(accounted(result), 50);
    let unavailable = 0;
    for (const row of result.screened) {
      assert.ok((row['sections_unavailable'] as Row[]).some(section => section['section'] === 'charges'));
      assert.ok(!(row['sections_included'] as string[]).includes('charges'));
      unavailable++;
    }
    reports.push({ scenario: 'charges fault', fault, screened: result.screened.length,
      not_screened: result.not_screened.length, unavailable, ...h.stats(), passed: true });
  } finally { await h.close(); }
}

{
  const h = await setup({ limit: 60 });
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      h.client.callTool({ name: 'screen_companies', arguments: { companies: numbers } })));
    results.map(body).forEach(result => assert.equal(accounted(result), 50));
    assert.ok(h.stats().calls <= 57, 'shared budget overspent');
    reports.push({ scenario: '10 batches competing for 57-request budget', ...h.stats(), passed: true });
  } finally { await h.close(); }
}

for (const inputs of [[numbers[0]!, numbers[0]!], [numbers[0]!, ''], [numbers[0]!, '   '], ['   ']]) {
  const h = await setup();
  try {
    const result = body(await h.client.callTool({ name: 'screen_companies', arguments: { companies: inputs } }));
    reports.push({ scenario: 'input reconciliation', inputs, requested: result.requested,
      accounted: accounted(result), passed: result.requested === accounted(result) });
  } finally { await h.close(); }
}

{
  const h = await setup({ latency: 100, timeout: 20 });
  try {
    const result = body(await h.client.callTool({ name: 'screen_companies', arguments: { companies: numbers } }));
    assert.equal(result.not_screened.length, 50);
    assert.equal(result.screened.length, 0);
    reports.push({ scenario: 'all 50 profile requests time out', ...h.stats(), passed: true });
  } finally { await h.close(); }
}

{
  const h = await setup();
  try {
    for (const companies of [[], [...numbers, '10000051'], [42], ['x'.repeat(257)]]) {
      let rejected = false;
      try { const result = await h.client.callTool({ name: 'screen_companies', arguments: { companies } }); rejected = result.isError === true; }
      catch { rejected = true; }
      assert.ok(rejected, 'invalid input accepted');
    }
    assert.equal(h.stats().calls, 0);
    assert.equal(body(await h.client.callTool({ name: 'screen_companies', arguments: { companies: [numbers[0]] } })).screened.length, 1);
    reports.push({ scenario: 'four invalid inputs rejected before upstream; next valid call succeeds', passed: true });
  } finally { await h.close(); }
}

{
  const h = await setup({ latency: 15 });
  try {
    const controller = new AbortController();
    const pending = h.client.callTool({ name: 'screen_companies', arguments: { companies: numbers, include_officers: true } }, undefined, { signal: controller.signal });
    await delay(25);
    controller.abort();
    await pending.catch(() => undefined);
    const atCancel = h.stats().calls;
    await delay(1400);
    reports.push({ scenario: 'cancel running batch', calls_at_cancel: atCancel,
      calls_after_settle: h.stats().calls, additional_calls: h.stats().calls - atCancel,
      passed: h.stats().calls === atCancel });
  } finally { await h.close(); }
}
console.log(JSON.stringify({ generated_at: new Date().toISOString(), mock_latency_ms: 2,
  note: 'Offline real MCP client/server with synthetic upstream, zero retries and real clock. Not a production throughput benchmark.', reports }, null, 2));
if (reports.some(report => report['passed'] === false)) process.exitCode = 1;
