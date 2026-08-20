import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../../src/config.js';

const FIXTURE_ROOT = join(import.meta.dirname, '..', 'fixtures');

export function loadFixture<T = unknown>(relativePath: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, relativePath), 'utf8')) as T;
}

/**
 * A config with everything pinned to test-friendly values. Overrides are
 * shallow-merged so a test can change one field and say what it is testing.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://api.example-companies-house.test',
    rateLimit: 600,
    rateWindowMs: 300_000,
    rateSafetyMargin: 0.95,
    cacheEnabled: false,
    cacheDir: join(tmpdir(), 'companies-house-mcp-tests-unused'),
    timeoutMs: 5_000,
    maxRetries: 3,
    retryBaseMs: 100,
    userAgent: 'companies-house-mcp-tests',
    logLevel: 'error',
    ...overrides
  };
}

export async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ch-mcp-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Deterministic stand-in for Math.random, so jitter is reproducible. */
export function fixedRandom(value = 0): () => number {
  return () => value;
}
