/**
 * Replaces the hand-authored fixtures with real recorded responses.
 *
 *   npm run record-fixtures
 *
 * COMPANIES_HOUSE_API_KEY comes from the environment or from a .env at the
 * repository root.
 *
 * Read the resulting diff rather than committing it blind. It is the first
 * honest answer to "is our understanding of this API correct", and anything
 * surprising in it is worth chasing down before it becomes a bug.
 *
 * Two fixtures cannot be recorded from a fixed company number, because they
 * need a company that is actually dissolved and one that actually has an
 * insolvency case. Point the script at real examples with:
 *
 *   CH_FIXTURE_DISSOLVED_COMPANY=SC000000
 *   CH_FIXTURE_INSOLVENT_COMPANY=00000000
 *
 * in the same .env.
 *
 * Without those the script records everything else and says which it skipped.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { loadEnvFile } from '../src/env-file.js';
import type { ResourceKind } from '../src/http/cache.js';
import type { QueryParams } from '../src/http/client.js';
import { CompaniesHouseClient } from '../src/http/client.js';
import { officerIdFromItem } from '../src/domain/format.js';
import { arr, obj } from '../src/domain/read.js';
import { createLogger } from '../src/telemetry/logger.js';

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
const SUBJECT = '00000006';

const FIXTURES: FixtureSpec[] = [
  { file: 'company/profile-active.json', path: `/company/${SUBJECT}`, resource: 'company-profile' },
  { file: 'officers/officers-list.json', path: `/company/${SUBJECT}/officers`, resource: 'officers' },
  { file: 'charges/charges-outstanding.json', path: `/company/${SUBJECT}/charges`, resource: 'charges' },
  {
    file: 'psc/psc-list.json',
    path: `/company/${SUBJECT}/persons-with-significant-control`,
    resource: 'psc'
  },
  {
    file: 'filing-history/filing-history.json',
    path: `/company/${SUBJECT}/filing-history`,
    query: { items_per_page: 5 },
    resource: 'filing-history'
  },
  {
    file: 'search/companies.json',
    path: '/search/companies',
    query: { q: 'limited', items_per_page: 5 },
    resource: 'search'
  },
  {
    file: 'search/officers.json',
    path: '/search/officers',
    query: { q: 'smith', items_per_page: 5 },
    resource: 'search'
  }
];

const FIXTURE_ROOT = join(import.meta.dirname, '..', 'tests', 'fixtures');

async function main(): Promise<void> {
  loadEnvFile(join(import.meta.dirname, '..', '.env'));
  const logger = createLogger({ level: 'info' });
  const config = loadConfig();
  // Recording through the cache would happily re-record what is already on
  // disk, which defeats the point of the exercise.
  const client = new CompaniesHouseClient({ config: { ...config, cacheEnabled: false }, logger });

  const write = async (file: string, data: unknown): Promise<void> => {
    const target = join(FIXTURE_ROOT, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    logger.info('recorded', { file });
  };

  let failures = 0;
  const skipped: string[] = [];

  const record = async (spec: FixtureSpec): Promise<unknown | undefined> => {
    try {
      const { data } = await client.get<unknown>({
        path: spec.path,
        resource: spec.resource,
        bypassCache: true,
        ...(spec.query === undefined ? {} : { query: spec.query })
      });
      await write(spec.file, data);
      return data;
    } catch (error) {
      failures += 1;
      logger.error('failed to record fixture', { file: spec.file, error });
      return undefined;
    }
  };

  let officersPayload: unknown;
  for (const fixture of FIXTURES) {
    const data = await record(fixture);
    if (fixture.file === 'officers/officers-list.json') officersPayload = data;
  }

  // The appointments fixture needs an officer ID, which only exists inside a
  // URL in the officers response, so it is derived from what we just recorded
  // rather than hardcoded and left to rot.
  const officerId = arr(obj(officersPayload)['items'])
    .map((item) => officerIdFromItem(item))
    .find((id): id is string => id !== undefined);

  if (officerId === undefined) {
    skipped.push('officers/appointments.json (no officer id in the recorded officers response)');
  } else {
    await record({
      file: 'officers/appointments.json',
      path: `/officers/${encodeURIComponent(officerId)}/appointments`,
      resource: 'officer-appointments'
    });
  }

  const dissolved = process.env['CH_FIXTURE_DISSOLVED_COMPANY'];
  if (dissolved === undefined || dissolved.trim() === '') {
    skipped.push('company/profile-dissolved.json (set CH_FIXTURE_DISSOLVED_COMPANY)');
  } else {
    await record({
      file: 'company/profile-dissolved.json',
      path: `/company/${dissolved.trim()}`,
      resource: 'company-profile'
    });
  }

  const insolvent = process.env['CH_FIXTURE_INSOLVENT_COMPANY'];
  if (insolvent === undefined || insolvent.trim() === '') {
    skipped.push('insolvency/insolvency-case.json (set CH_FIXTURE_INSOLVENT_COMPANY)');
  } else {
    await record({
      file: 'insolvency/insolvency-case.json',
      path: `/company/${insolvent.trim()}/insolvency`,
      resource: 'insolvency'
    });
  }

  for (const note of skipped) logger.warn('skipped', { fixture: note });

  if (failures > 0) {
    logger.error('some fixtures were not recorded', { failures });
    process.exitCode = 1;
    return;
  }

  logger.info('recording finished — review the diff before committing', {
    recorded: FIXTURES.length + (officerId === undefined ? 0 : 1),
    skipped: skipped.length
  });
}

await main();
