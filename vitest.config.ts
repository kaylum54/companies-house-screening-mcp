import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

import { loadEnvFile } from './src/node/env-file.js';

// Loads the repository's own .env from a known path, so `npm test` picks up a
// key without one having to be exported in every new terminal. Variables
// already set in the shell win over the file.
loadEnvFile(join(import.meta.dirname, '.env'));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The live smoke test hits the real API and has its own config
    // (vitest.live.config.ts), so it never runs as part of `npm test`.
    //
    // tests/workers/ needs a Worker isolate, not Node: it imports
    // `cloudflare:test`, which only exists inside the workerd pool. It has its
    // own config too (vitest.workers.config.ts) and runs as `npm run
    // test:workers`. CI runs both.
    exclude: ['tests/live.smoke.test.ts', 'tests/workers/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // bin.ts is covered by tests/bin.test.ts, which spawns it as a real
      // process — the only way to exercise the shebang, the stdio framing and
      // the config exit code. In-process v8 instrumentation cannot see a
      // subprocess, so leaving it in would report 0% for a file that is
      // tested, and the number would push everyone towards deleting the
      // better test.
      exclude: ['src/bin.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85
      }
    }
  }
});
