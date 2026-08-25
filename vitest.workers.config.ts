import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests that run inside `workerd`, the runtime Cloudflare actually deploys.
 *
 * Separate from `vitest.config.ts` because the two cannot share a pool: the
 * Node suite needs Node, and these need a Worker isolate. `npm test` runs the
 * Node suite, `npm run test:workers` runs this one, and CI runs both.
 *
 * The gap this closes is not hypothetical. `globalThis.fetch` stored detached
 * works under Node and throws `TypeError: Illegal invocation` on workerd — so
 * every test passed while every request on the deployed Worker failed. Nothing
 * short of the real runtime could have caught it: the hand-written stand-ins
 * in `tests/cloudflare.test.ts` model what we *believe* the platform does, and
 * that belief was the thing that was wrong.
 */

const FIXTURES = join(import.meta.dirname, 'tests', 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const PROFILE = fixture('company/profile-active.json');
const CHARGES = fixture('charges/charges-outstanding.json');
const INSOLVENCY = fixture('insolvency/insolvency-case.json');
const OFFICERS = fixture('officers/officers-list.json');

/**
 * Stands in for Companies House at the platform's egress, not inside our code.
 *
 * This matters: the Worker still calls `globalThis.fetch` for real and workerd
 * still applies its own rules to that call — only the far end is ours. Mocking
 * inside the client instead would skip the very thing that broke in
 * production.
 */
function companiesHouse(request: Request): Response {
  const { pathname } = new URL(request.url);
  const json = (body: string): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

  if (pathname.endsWith('/charges')) return json(CHARGES);
  if (pathname.endsWith('/insolvency')) return json(INSOLVENCY);
  if (pathname.endsWith('/officers')) return json(OFFICERS);
  if (/^\/company\/[^/]+$/.test(pathname)) return json(PROFILE);

  return new Response(JSON.stringify({ errors: [{ error: 'not-found' }] }), {
    status: 404,
    headers: { 'content-type': 'application/json' }
  });
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Bindings come from the real deployment config, so a test cannot pass
      // against a topology the deployment does not have.
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // Supplied by `wrangler secret put` in production, so it is absent
        // from wrangler.toml by design and has to be provided here.
        bindings: { COMPANIES_HOUSE_API_KEY: 'test-key-for-workerd' },
        // Every outbound request the Worker makes lands here. Nothing in this
        // suite can reach the real internet.
        outboundService: companiesHouse
      }
    })
  ],
  test: {
    include: ['tests/workers/**/*.test.ts']
  }
});
