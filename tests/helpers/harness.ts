import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { FakeClock } from '../../src/clock.js';
import { ResponseCache } from '../../src/http/cache.js';
import { CompaniesHouseClient } from '../../src/http/client.js';
import { RateLimiter } from '../../src/http/rate-limiter.js';
import { createServer } from '../../src/server.js';
import { silentLogger } from '../../src/telemetry/logger.js';
import type { FakeCall, FakeResponseSpec } from './fake-fetch.js';
import { fakeFetchAlways, fakeFetchRouter, fakeFetchSequence } from './fake-fetch.js';
import { fixedRandom, testConfig } from './support.js';

/**
 * Runs the real MCP server against a real MCP client over an in-memory
 * transport.
 *
 * Calling the handler functions directly would be simpler and would test less
 * than half of what matters. Going through a client exercises tool
 * registration, input parsing, output-schema validation on the client side,
 * and the error envelope — which is where the interesting mistakes live. A
 * tool whose declared output schema does not match what it returns passes
 * every unit test and fails on first contact with a host.
 */

/** 2026-08-20T00:00:00Z, so age arithmetic in assertions is stable. */
export const HARNESS_NOW = Date.parse('2026-08-20T00:00:00.000Z');

export interface Harness {
  client: Client;
  calls: FakeCall[];
  close: () => Promise<void>;
}

export interface HarnessOptions {
  /** Lowered in tests that need the budget to run out. */
  rateLimit?: number;
}

async function build(
  fetchImpl: typeof fetch,
  calls: FakeCall[],
  options: HarnessOptions = {}
): Promise<Harness> {
  const clock = new FakeClock(HARNESS_NOW);
  const config = testConfig({
    cacheEnabled: false,
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit })
  });

  const companiesHouse = new CompaniesHouseClient({
    config,
    clock,
    fetchImpl,
    random: fixedRandom(0),
    cache: new ResponseCache({ dir: config.cacheDir, enabled: false, clock }),
    limiter: new RateLimiter({
      limit: config.rateLimit,
      windowMs: config.rateWindowMs,
      safetyMargin: config.rateSafetyMargin,
      clock,
      jitterMs: 0,
      random: fixedRandom(0)
    })
  });

  const server = createServer(
    { client: companiesHouse, logger: silentLogger, now: () => HARNESS_NOW },
    '0.0.0-test'
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'companies-house-screening-mcp-tests', version: '0.0.0-test' });
  await client.connect(clientTransport);

  return {
    client,
    calls,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

/** Every upstream request returns the same response. */
export async function harnessAlways(spec: FakeResponseSpec): Promise<Harness> {
  const fake = fakeFetchAlways(spec);
  return build(fake.fetch, fake.calls);
}

/** Upstream responses are returned in order. */
export async function harnessSequence(specs: FakeResponseSpec[]): Promise<Harness> {
  const fake = fakeFetchSequence(specs);
  return build(fake.fetch, fake.calls);
}

/** Upstream responses are chosen by matching the request URL. */
export async function harnessRoutes(
  routes: [RegExp, FakeResponseSpec][],
  options: HarnessOptions = {}
): Promise<Harness> {
  const fake = fakeFetchRouter(routes);
  return build(fake.fetch, fake.calls, options);
}

/** Reads the structured result of a tool call, asserting it was not an error. */
export function structured(result: unknown): Record<string, unknown> {
  const typed = result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: unknown };
  if (typed.isError === true) {
    throw new Error(`expected success, got error result: ${JSON.stringify(typed.content)}`);
  }
  if (typed.structuredContent === undefined) {
    throw new Error('tool returned no structured content');
  }
  return typed.structuredContent;
}

/** Reads the error payload of a tool call, asserting it was an error. */
export function errorPayload(result: unknown): {
  code: string;
  message: string;
  next_step: string;
  retryable: boolean;
} {
  const typed = result as { isError?: boolean; content?: { type: string; text: string }[] };
  if (typed.isError !== true) {
    throw new Error('expected an error result, got a success');
  }
  const text = typed.content?.[0]?.text ?? '{}';
  return (JSON.parse(text) as { error: ReturnType<typeof errorPayload> }).error;
}
