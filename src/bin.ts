#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ConfigError, loadConfig, redactConfig } from './config.js';
import { loadEnvFile } from './node/env-file.js';
import { CompaniesHouseClient } from './http/client.js';
import { defaultCacheDir } from './node/cache-dir.js';
import { FileCacheStore } from './node/file-cache-store.js';
import { createServer } from './server.js';
import { createLogger } from './telemetry/logger.js';
import { packageVersion } from './node/version.js';

/**
 * stdio entry point.
 *
 * Nothing in this process may write to stdout: the transport owns it, and a
 * stray write corrupts the JSON-RPC framing in a way that surfaces as an
 * unexplained parse error on the client side. All diagnostics go to stderr.
 */

/** sysexits.h EX_CONFIG. Distinguishes "you set it up wrong" from "it crashed". */
const EXIT_CONFIG = 78;

async function main(): Promise<void> {
  // Opt-in only, and by explicit path. A host launches this server with its
  // own working directory, so reading a `.env` from wherever that happens to
  // be is a way to pick up someone else's credentials by accident.
  const envFile = process.env['CH_ENV_FILE'];
  if (envFile !== undefined && envFile.trim() !== '') {
    const result = loadEnvFile(envFile.trim());
    if (!result.loaded) {
      const reason = result.error === undefined ? 'no such file' : result.error;
      process.stderr.write(`CH_ENV_FILE points at ${result.path}, which could not be read: ${reason}.\n`);
      process.exit(EXIT_CONFIG);
    }
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n\nSee .env.example or the README for the full list.\n`);
      process.exit(EXIT_CONFIG);
    }
    throw error;
  }

  const version = packageVersion();
  const logger = createLogger({ level: config.logLevel });
  // The cache directory is resolved here rather than in `loadConfig`, because
  // only an entry point that has a filesystem should be deciding where on the
  // filesystem things go. See ADR 14.
  const cacheDir = config.cacheDir ?? defaultCacheDir(process.env);
  const client = new CompaniesHouseClient({
    config,
    logger,
    cacheStore: new FileCacheStore({ dir: cacheDir, logger })
  });
  const server = createServer({ client, logger, now: () => Date.now() }, version);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    logger.info('shutting down', { signal });
    void server
      .close()
      .catch((error: unknown) => logger.error('error while closing', { error }))
      .finally(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());

  // Logged after connecting so that the line means "ready", not "starting".
  logger.info('companies-house-screening-mcp ready', { version, ...redactConfig(config) });
}

await main().catch((error: unknown) => {
  process.stderr.write(`companies-house-screening-mcp failed to start: ${String(error)}\n`);
  process.exit(1);
});
