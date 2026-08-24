import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

import { loadEnvFile } from './src/node/env-file.js';

/**
 * Config for the live smoke test only.
 *
 * A separate config rather than an environment-variable switch on the main
 * one. The switch used to be `CH_LIVE_SMOKE=1 vitest run …` in the npm script,
 * which is bash syntax: on Windows, npm runs scripts through cmd.exe and the
 * whole command fails with "'CH_LIVE_SMOKE' is not recognized". Two configs
 * work identically on every platform and need no extra dependency.
 */

loadEnvFile(join(import.meta.dirname, '.env'));

export default defineConfig({
  test: {
    include: ['tests/live.smoke.test.ts']
  }
});
