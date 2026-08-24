#!/usr/bin/env node
import { ConfigError, loadConfig, redactConfig } from './config.js';
import { createMcpHttpServer } from './node/http-server.js';
import { defaultCacheDir } from './node/cache-dir.js';
import { FileCacheStore } from './node/file-cache-store.js';
import { loadEnvFile } from './node/env-file.js';
import { createLogger } from './telemetry/logger.js';
import { packageVersion } from './node/version.js';
import { defaultClientReservation } from './transport/sessions.js';

/**
 * Streamable HTTP entry point, for running this server as a hosted service.
 *
 * The stdio entry point in `bin.ts` is unchanged and remains the right way to
 * run this locally. This one exists for the clients that cannot spawn a
 * process — claude.ai on web and mobile, hosted agent platforms — and for
 * anyone who wants one deployment serving a team rather than a copy per
 * laptop. See ADR 12.
 *
 * Unlike the stdio server, stdout is not sacred here: the transport is HTTP,
 * so logs may go wherever. They still go to stderr, for consistency and
 * because a container runtime collects both.
 */

/** sysexits.h EX_CONFIG. Distinguishes "you set it up wrong" from "it crashed". */
const EXIT_CONFIG = 78;

async function main(): Promise<void> {
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
  const cacheDir = config.cacheDir ?? defaultCacheDir(process.env);

  const server = createMcpHttpServer({
    config,
    logger,
    version,
    cacheStore: new FileCacheStore({ dir: cacheDir, logger })
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    logger.info('shutting down', { signal });

    const closeSessions = (server as { closeSessions?: () => Promise<void> }).closeSessions;
    void Promise.resolve(closeSessions?.())
      .catch((error: unknown) => logger.error('error closing sessions', { error }))
      .finally(() => {
        server.close(() => process.exit(0));
        // Do not wait forever on a client holding an SSE stream open.
        setTimeout(() => process.exit(0), 5_000).unref();
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // `listen` reports failure by emitting, not by throwing. Without this
  // listener an occupied port becomes an uncaught exception on a promise that
  // never settles, which is a stack trace instead of the sentence below.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpPort, config.httpHost, () => {
      server.removeListener('error', reject);
      resolve();
    });
  }).catch((error: unknown) => {
    const reason = (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
      ? `port ${config.httpPort} is already in use`
      : String(error);
    process.stderr.write(
      `companies-house-screening-mcp could not listen on ${config.httpHost}:${config.httpPort}: ${reason}.\n`
    );
    process.exit(EXIT_CONFIG);
  });

  logger.info('companies-house-screening-mcp ready over http', {
    version,
    endpoint: `http://${config.httpHost}:${config.httpPort}/mcp`,
    ...redactConfig(config),
    // After the spread, not before: `redactConfig` carries its own
    // `clientReservation`, which is `undefined` whenever the value is derived
    // rather than set — so ordering this first dropped it from the log line in
    // exactly the case where somebody wants to read it.
    clientReservation: defaultClientReservation(config)
  });

  if (config.httpHost === '127.0.0.1' || config.httpHost === 'localhost') {
    // Worth saying out loud: the safe default is not the one a deployment wants.
    logger.info('bound to loopback only; set CH_HTTP_HOST=0.0.0.0 to accept external connections');
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`companies-house-screening-mcp failed to start: ${String(error)}\n`);
  process.exit(1);
});
