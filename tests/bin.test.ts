import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Exercises the compiled entry point as a real process.
 *
 * Everything else in this suite tests the server through an in-memory
 * transport, which never touches the shebang, the config failure path, the
 * stdio framing, or the rule that nothing may write to stdout. Those are
 * exactly the things that break a published MCP server for everybody at once,
 * and they were verified by hand once and would otherwise never be verified
 * again.
 *
 * Requires `npm run build` first. Skipped when dist is absent so that a plain
 * `npm test` on a fresh clone still works; CI builds before testing, so there
 * it always runs.
 */

const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js');
const built = existsSync(BIN);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(input: string, env: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));

    child.stdin.end(input);
  });
}

const rpc = (payloads: unknown[]): string =>
  `${payloads.map((payload) => JSON.stringify(payload)).join('\n')}\n`;

const HANDSHAKE = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'bin-test', version: '0.0.0' }
    }
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' }
];

describe.skipIf(!built)('the compiled entry point', () => {
  it('completes a handshake and lists its tools over stdio', async () => {
    const { stdout, code } = await run(rpc(HANDSHAKE), {
      COMPANIES_HOUSE_API_KEY: 'not-a-real-key',
      CH_LOG_LEVEL: 'error'
    });

    expect(code).toBe(0);
    const messages = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: number; result?: Record<string, unknown> });

    const initialise = messages.find((message) => message.id === 1)?.result;
    expect((initialise?.['serverInfo'] as { name?: string } | undefined)?.name).toBe('companies-house');
    expect(String(initialise?.['instructions'])).toContain('find_company');

    const tools = (messages.find((message) => message.id === 2)?.result?.['tools'] ?? []) as {
      name: string;
    }[];
    expect(tools).toHaveLength(9);
  });

  it('writes nothing but JSON-RPC to stdout', async () => {
    // A single stray console.log anywhere in the process corrupts the framing,
    // and the failure surfaces on the client as an unexplained parse error
    // that points nowhere near the line that caused it.
    const { stdout } = await run(rpc(HANDSHAKE), {
      COMPANIES_HOUSE_API_KEY: 'not-a-real-key',
      CH_LOG_LEVEL: 'debug'
    });

    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(JSON.parse(line)).toHaveProperty('jsonrpc', '2.0');
    }
  });

  it('exits with EX_CONFIG and an actionable message when the key is missing', async () => {
    const { stdout, stderr, code } = await run('', { COMPANIES_HOUSE_API_KEY: undefined });

    expect(code).toBe(78);
    expect(stderr).toContain('COMPANIES_HOUSE_API_KEY is required');
    // Even the failure path must not put anything on stdout.
    expect(stdout).toBe('');
  });

  it('reports every configuration problem at once', async () => {
    const { stderr, code } = await run('', {
      COMPANIES_HOUSE_API_KEY: undefined,
      CH_RATE_LIMIT: 'lots',
      CH_LOG_LEVEL: 'shouty'
    });

    expect(code).toBe(78);
    expect(stderr).toContain('COMPANIES_HOUSE_API_KEY');
    expect(stderr).toContain('CH_RATE_LIMIT');
    expect(stderr).toContain('CH_LOG_LEVEL');
  });
});
