/**
 * Replaces the hand-authored fixtures with real recorded responses.
 *
 *   COMPANIES_HOUSE_API_KEY=... npm run record-fixtures
 *
 * Read the resulting diff rather than committing it blind. It is the first
 * honest answer to "is our understanding of this API correct", and anything
 * surprising in it is worth chasing down before it becomes a bug.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { CompaniesHouseClient } from '../src/http/client.js';
import { createLogger } from '../src/telemetry/logger.js';
import type { ResourceKind } from '../src/http/cache.js';
import type { QueryParams } from '../src/http/client.js';

interface FixtureSpec {
  file: string;
  path: string;
  query?: QueryParams;
  resource: ResourceKind;
}

/**
 * Company 00000006 is the example used throughout the Companies House
 * developer documentation, which makes it a reasonable stable target.
 */
const FIXTURES: FixtureSpec[] = [
  { file: 'company/profile-active.json', path: '/company/00000006', resource: 'company-profile' },
  { file: 'officers/officers-list.json', path: '/company/00000006/officers', resource: 'officers' },
  { file: 'charges/charges-outstanding.json', path: '/company/00000006/charges', resource: 'charges' },
  {
    file: 'search/companies.json',
    path: '/search/companies',
    query: { q: 'limited', items_per_page: 5 },
    resource: 'search'
  }
];

const FIXTURE_ROOT = join(import.meta.dirname, '..', 'tests', 'fixtures');

async function main(): Promise<void> {
  const logger = createLogger({ level: 'info' });
  const config = loadConfig();
  const client = new CompaniesHouseClient({ config, logger });

  let failures = 0;

  for (const fixture of FIXTURES) {
    const target = join(FIXTURE_ROOT, fixture.file);
    try {
      const { data, meta } = await client.get<unknown>({
        path: fixture.path,
        resource: fixture.resource,
        bypassCache: true,
        ...(fixture.query === undefined ? {} : { query: fixture.query })
      });

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      logger.info('recorded', { file: fixture.file, durationMs: meta.durationMs });
    } catch (error) {
      failures += 1;
      logger.error('failed to record fixture', { file: fixture.file, error });
    }
  }

  if (failures > 0) {
    logger.error('some fixtures were not recorded', { failures });
    process.exitCode = 1;
    return;
  }

  logger.info('all fixtures recorded — review the diff before committing', {
    count: FIXTURES.length
  });
}

await main();
