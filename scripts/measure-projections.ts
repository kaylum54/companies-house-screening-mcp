/**
 * Measures what the projection layer actually saves.
 *
 *   npx tsx scripts/measure-projections.ts
 *
 * This exists because the first version of this project's README claimed the
 * projections cut payloads "by roughly an order of magnitude", which was an
 * assumption nobody had checked. The real figure against the current fixtures
 * is between 29% and 42%. The claim was wrong, the code was fine, and the only
 * way to keep the two honest is to measure rather than assert.
 *
 * Caveat worth keeping in mind when reading the output: the fixtures are
 * hand-authored and lighter than real Companies House responses, which carry
 * more link blocks and more nested detail. The saving on live data should be
 * better than this. It has not been measured, so it is not claimed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  projectCharges,
  projectCompanyProfile,
  projectCompanySearch,
  projectFilingHistory,
  projectInsolvency,
  projectOfficerAppointments,
  projectOfficerSearch,
  projectOfficers,
  projectPsc
} from '../src/domain/projections.js';

const FIXTURE_ROOT = join(import.meta.dirname, '..', 'tests', 'fixtures');
const NOW = Date.parse('2026-08-20T00:00:00.000Z');

const load = (relativePath: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURE_ROOT, relativePath), 'utf8')) as unknown;

export interface Measurement {
  name: string;
  rawBytes: number;
  shapedBytes: number;
  ratio: number;
}

export function measure(): Measurement[] {
  const cases: { name: string; fixture: string; project: (raw: unknown) => unknown }[] = [
    {
      name: 'company profile',
      fixture: 'company/profile-active.json',
      project: (raw) => projectCompanyProfile(raw, '00000006', NOW)
    },
    {
      name: 'officers',
      fixture: 'officers/officers-list.json',
      project: (raw) => projectOfficers(raw, '00000006', false)
    },
    {
      name: 'company search',
      fixture: 'search/companies.json',
      project: (raw) => projectCompanySearch(raw, 'example fixture')
    },
    {
      name: 'officer search',
      fixture: 'search/officers.json',
      project: (raw) => projectOfficerSearch(raw, 'alice fixture')
    },
    {
      name: 'charges',
      fixture: 'charges/charges-outstanding.json',
      project: (raw) => projectCharges(raw, '00000006')
    },
    { name: 'psc', fixture: 'psc/psc-list.json', project: (raw) => projectPsc(raw, '00000006') },
    {
      name: 'insolvency',
      fixture: 'insolvency/insolvency-case.json',
      project: (raw) => projectInsolvency(raw, 'SC123456')
    },
    {
      name: 'filing history',
      fixture: 'filing-history/filing-history.json',
      project: (raw) => projectFilingHistory(raw, '00000006')
    },
    {
      name: 'officer appointments',
      fixture: 'officers/appointments.json',
      project: (raw) => projectOfficerAppointments(raw, 'aBcD1234EfGh5678IjKl')
    }
  ];

  return cases.map(({ name, fixture, project }) => {
    const raw = load(fixture);
    const rawBytes = JSON.stringify(raw).length;
    const shapedBytes = JSON.stringify(project(raw)).length;
    return { name, rawBytes, shapedBytes, ratio: shapedBytes / rawBytes };
  });
}

function main(): void {
  const results = measure();
  const width = Math.max(...results.map((result) => result.name.length));

  process.stdout.write('Projection size against the raw Companies House payload\n\n');
  for (const { name, rawBytes, shapedBytes, ratio } of results) {
    const saved = ((1 - ratio) * 100).toFixed(0);
    process.stdout.write(
      `  ${name.padEnd(width)}  ${String(rawBytes).padStart(5)} → ${String(shapedBytes).padStart(5)} bytes   ${saved}% smaller\n`
    );
  }

  const best = Math.min(...results.map((result) => result.ratio));
  const worst = Math.max(...results.map((result) => result.ratio));
  process.stdout.write(
    `\n  Range: ${((1 - worst) * 100).toFixed(0)}% to ${((1 - best) * 100).toFixed(0)}% smaller.\n`
  );
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
