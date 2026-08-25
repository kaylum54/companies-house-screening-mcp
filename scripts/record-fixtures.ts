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
 * Subjects are chosen deliberately, and the choice is an editorial one as much
 * as a technical one. These names end up in public documentation, so the
 * examples are institutions and widely-reported corporate failures rather than
 * small trading businesses: the register entry for Royal Mail or Carillion is
 * already among the most-read public records in the country, and an
 * illustrative example there imputes nothing to anybody. A two-director corner
 * shop used as "the supplier you should worry about" would.
 *
 *   active      04138203  Royal Mail Group Limited — officers, charges and PSC
 *                         all populated, so every section records something.
 *   dissolved   00000006  Marine and General Mutual Life Assurance Society,
 *                         incorporated 1862 and long dissolved. This is the
 *                         Companies House documentation's own example company.
 *   insolvency  03782379  Carillion PLC, in liquidation.
 *
 * Override any of them:
 *
 *   CH_FIXTURE_COMPANY=00000000
 *   CH_FIXTURE_DISSOLVED_COMPANY=SC000000
 *   CH_FIXTURE_INSOLVENT_COMPANY=00000000
 *
 * Page sizes are capped so a fixture stays readable in a diff. Royal Mail has
 * fifteen charges and thirty-five officers; five of each is enough to exercise
 * every field.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { loadEnvFile } from '../src/node/env-file.js';
import type { ResourceKind } from '../src/http/cache.js';
import type { QueryParams } from '../src/http/client.js';
import { CompaniesHouseClient } from '../src/http/client.js';
import { officerIdFromItem } from '../src/domain/format.js';
import { arr, num, obj } from '../src/domain/read.js';
import { createLogger } from '../src/telemetry/logger.js';

interface FixtureSpec {
  file: string;
  path: string;
  query?: QueryParams;
  resource: ResourceKind;
}

const env = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
};

const SUBJECT = env('CH_FIXTURE_COMPANY', '04138203');
const DISSOLVED = env('CH_FIXTURE_DISSOLVED_COMPANY', '00000006');
const INSOLVENT = env('CH_FIXTURE_INSOLVENT_COMPANY', '03782379');

const PAGE = 5;

const FIXTURES: FixtureSpec[] = [
  { file: 'company/profile-active.json', path: `/company/${SUBJECT}`, resource: 'company-profile' },
  {
    file: 'officers/officers-list.json',
    path: `/company/${SUBJECT}/officers`,
    query: { items_per_page: PAGE },
    resource: 'officers'
  },
  {
    file: 'charges/charges-outstanding.json',
    path: `/company/${SUBJECT}/charges`,
    query: { items_per_page: PAGE },
    resource: 'charges'
  },
  {
    file: 'psc/psc-list.json',
    path: `/company/${SUBJECT}/persons-with-significant-control`,
    query: { items_per_page: PAGE },
    resource: 'psc'
  },
  {
    file: 'filing-history/filing-history.json',
    path: `/company/${SUBJECT}/filing-history`,
    query: { items_per_page: PAGE },
    resource: 'filing-history'
  },
  { file: 'company/profile-dissolved.json', path: `/company/${DISSOLVED}`, resource: 'company-profile' },
  { file: 'company/profile-insolvent.json', path: `/company/${INSOLVENT}`, resource: 'company-profile' },
  {
    file: 'insolvency/insolvency-case.json',
    path: `/company/${INSOLVENT}/insolvency`,
    resource: 'insolvency'
  },
  {
    file: 'search/companies.json',
    path: '/search/companies',
    query: { q: 'royal mail', items_per_page: PAGE },
    resource: 'search'
  },
  {
    file: 'search/officers.json',
    path: '/search/officers',
    query: { q: 'smith', items_per_page: PAGE },
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
  //
  // Of the officers available, take the one sitting on the most companies. The
  // first officer in the list is often the company secretary with a single
  // appointment, which makes a poor example for the tool whose entire purpose
  // is following a person across companies.
  const officerIds = arr(obj(officersPayload)['items'])
    .map((item) => officerIdFromItem(item))
    .filter((id): id is string => id !== undefined);

  let best: { id: string; count: number } | undefined;
  for (const id of officerIds) {
    try {
      const { data } = await client.get<unknown>({
        path: `/officers/${encodeURIComponent(id)}/appointments`,
        resource: 'officer-appointments',
        bypassCache: true
      });
      const count = num(obj(data)['total_results']) ?? 0;
      if (best === undefined || count > best.count) best = { id, count };
    } catch {
      // An officer whose appointments cannot be read is simply not a candidate.
    }
  }

  if (best === undefined) {
    skipped.push('officers/appointments.json (no readable officer id in the recorded officers response)');
  } else {
    logger.info('chose the best-connected officer for the appointments fixture', {
      appointments: best.count
    });
    await record({
      file: 'officers/appointments.json',
      path: `/officers/${encodeURIComponent(best.id)}/appointments`,
      resource: 'officer-appointments'
    });
  }

  for (const note of skipped) logger.warn('skipped', { fixture: note });

  if (failures > 0) {
    logger.error('some fixtures were not recorded', { failures });
    process.exitCode = 1;
    return;
  }

  logger.info('recording finished — review the diff before committing', {
    recorded: FIXTURES.length + (best === undefined ? 0 : 1),
    skipped: skipped.length
  });
}

await main();
