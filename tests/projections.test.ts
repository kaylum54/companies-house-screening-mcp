import { describe, expect, it } from 'vitest';

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
import {
  getChargesOutput,
  getCompanyOutput,
  getFilingHistoryOutput,
  getInsolvencyOutput,
  getOfficerAppointmentsOutput,
  getOfficersOutput,
  getPscOutput
} from '../src/domain/schemas.js';
import { measure } from '../scripts/measure-projections.js';
import { loadFixture } from './helpers/support.js';

// 2026-08-20T00:00:00Z. Fixed so age arithmetic is reproducible.
const NOW = Date.parse('2026-08-20T00:00:00.000Z');

const meta = {
  cached: false,
  stale: false,
  rate_limit_remaining: 100,
  rate_limit_resets_in_ms: 0,
  licence: 'OGL-v3.0' as const
};

describe('projectCompanyProfile', () => {
  const raw = loadFixture('company/profile-active.json');
  const result = projectCompanyProfile(raw, '00000006', NOW);

  it('satisfies its own output schema', () => {
    expect(getCompanyOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('flattens the registered office to one line', () => {
    expect(result.registered_office_address).toBe(
      '1 Fixture Street, Testfield, Manchester, Greater Manchester, M1 1AA, England'
    );
  });

  it('translates the type slug into words', () => {
    expect(result.type).toBe('ltd');
    expect(result.type_description).toBe('Private limited company');
  });

  it('derives age in whole years', () => {
    expect(result.age_years).toBe(28);
    expect(result.flags.incorporated_within_last_year).toBe(false);
  });

  it('derives the risk flags rather than passing dates to the caller', () => {
    expect(result.flags).toMatchObject({
      is_active: true,
      accounts_overdue: false,
      confirmation_statement_overdue: false,
      has_charges: true,
      has_insolvency_history: false,
      has_been_liquidated: false
    });
  });

  it('reads the last accounts date out of its nested home', () => {
    expect(result.accounts.last_made_up_to).toBe('2025-03-31');
  });

  it('drops the fields nobody reads', () => {
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('"links"');
    expect(serialised).not.toContain('"etag"');
    expect(serialised).not.toContain('"kind"');
  });

  it('flags a dissolved company correctly', () => {
    const dissolved = projectCompanyProfile(
      loadFixture('company/profile-dissolved.json'),
      'SC123456',
      NOW
    );
    expect(dissolved.flags.is_active).toBe(false);
    expect(dissolved.flags.accounts_overdue).toBe(true);
    expect(dissolved.flags.has_been_liquidated).toBe(true);
    expect(dissolved.dissolved_on).toBe('2024-01-16');
  });

  it('survives an empty payload rather than throwing', () => {
    // Reading upstream loosely is the whole point: a field we do not get is a
    // field that is missing, not an outage.
    const empty = projectCompanyProfile({}, '00000006', NOW);
    expect(empty.company_number).toBe('00000006');
    expect(empty.flags.is_active).toBe(false);
    expect(getCompanyOutput.safeParse({ ...empty, meta }).success).toBe(true);
  });

  it('survives a payload with wrong-typed fields', () => {
    const odd = projectCompanyProfile(
      { company_name: 42, sic_codes: 'not-an-array', accounts: null, has_charges: 'yes' },
      '00000006',
      NOW
    );
    expect(odd.sic_codes).toEqual([]);
    expect(odd.flags.has_charges).toBe(false);
    expect(getCompanyOutput.safeParse({ ...odd, meta }).success).toBe(true);
  });
});

describe('projectCompanySearch', () => {
  const raw = loadFixture('search/companies.json');

  it('marks an exact name match and calls off disambiguation', () => {
    const result = projectCompanySearch(raw, 'example fixture trading limited');
    expect(result.exact_name_match).toBe('00000006');
    expect(result.disambiguation_needed).toBe(false);
  });

  it('asks for disambiguation when several near-misses come back', () => {
    const result = projectCompanySearch(raw, 'example fixture');
    expect(result.exact_name_match).toBeUndefined();
    expect(result.disambiguation_needed).toBe(true);
    expect(result.companies).toHaveLength(3);
  });

  it('does not ask for disambiguation on a single result', () => {
    const single = { items: [{ title: 'ONLY ONE LTD', company_number: '00000001' }] };
    expect(projectCompanySearch(single, 'something else').disambiguation_needed).toBe(false);
  });

  it('reads the advanced-search shape as well as the plain one', () => {
    // /search/companies returns `title` and `address_snippet`;
    // /advanced-search/companies returns `company_name` and a structured
    // address. Both have to land in the same output.
    const advanced = {
      hits: 1,
      items: [
        {
          company_name: 'ADVANCED SHAPE LIMITED',
          company_number: '09999999',
          company_status: 'active',
          company_type: 'plc',
          date_of_creation: '2016-01-01',
          registered_office_address: { address_line_1: '2 Other Road', locality: 'Leeds' }
        }
      ]
    };
    const result = projectCompanySearch(advanced, 'advanced shape limited');
    expect(result.companies[0]?.name).toBe('ADVANCED SHAPE LIMITED');
    expect(result.companies[0]?.address).toBe('2 Other Road, Leeds');
    expect(result.companies[0]?.type_description).toBe('Public limited company');
    expect(result.pagination.total_results).toBe(1);
  });

  it('skips hits that have no usable identity', () => {
    const broken = { items: [{ title: 'NO NUMBER LTD' }, { company_number: '00000002' }] };
    expect(projectCompanySearch(broken, 'x').companies).toHaveLength(0);
  });
});

describe('projectOfficers', () => {
  const raw = loadFixture('officers/officers-list.json');

  it('satisfies its own output schema', () => {
    const result = projectOfficers(raw, '00000006', false);
    expect(getOfficersOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('extracts the officer id, which the API only exposes inside a URL', () => {
    const result = projectOfficers(raw, '00000006', false);
    expect(result.officers[0]?.officer_id).toBe('aBcD1234EfGh5678IjKl');
  });

  it('marks resigned officers inactive', () => {
    const result = projectOfficers(raw, '00000006', false);
    expect(result.officers.map((officer) => officer.is_active)).toEqual([true, true, false]);
  });

  it('renders a partial date of birth without pretending to know the day', () => {
    const result = projectOfficers(raw, '00000006', false);
    expect(result.officers[0]?.date_of_birth).toBe('1979-07');
  });

  it('withholds service addresses unless verbose was asked for', () => {
    const quiet = projectOfficers(raw, '00000006', false);
    expect(quiet.officers[0]?.address).toBeUndefined();

    const verbose = projectOfficers(raw, '00000006', true);
    expect(verbose.officers[0]?.address).toContain('Fixture Street');
  });
});

describe('projectCharges', () => {
  const raw = loadFixture('charges/charges-outstanding.json');
  const result = projectCharges(raw, '00000006');

  it('satisfies its own output schema', () => {
    expect(getChargesOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('derives the outstanding count the API never reports', () => {
    expect(result.total_count).toBe(2);
    expect(result.satisfied_count).toBe(1);
    expect(result.outstanding_count).toBe(1);
  });

  it('never reports a negative outstanding count', () => {
    const inconsistent = { total_count: 1, satisfied_count: 3, part_satisfied_count: 1, items: [] };
    expect(projectCharges(inconsistent, '00000006').outstanding_count).toBe(0);
  });

  it('lifts the lender out of the nested particulars', () => {
    expect(result.charges[0]?.persons_entitled).toEqual(['EXAMPLE FIXTURE BANK PLC']);
    expect(result.charges[0]?.contains_floating_charge).toBe(true);
    expect(result.charges[0]?.floating_charge_covers_all).toBe(true);
  });
});

describe('projectPsc', () => {
  const raw = loadFixture('psc/psc-list.json');
  const result = projectPsc(raw, '00000006');

  it('satisfies its own output schema', () => {
    expect(getPscOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('marks a ceased interest inactive', () => {
    expect(result.controllers.map((controller) => controller.is_active)).toEqual([true, true, false]);
  });

  it('keeps the natures of control, which is the answer people want', () => {
    expect(result.controllers[0]?.natures_of_control).toContain('ownership-of-shares-75-to-100-percent');
  });

  it('falls back to the statement when no person is named', () => {
    // A company that cannot identify a controller files a statement instead,
    // and that record has no name field at all.
    const statement = {
      items: [{ kind: 'persons-with-significant-control-statement', statement: 'no-individual-or-entity-with-signficant-control', notified_on: '2017-07-01' }]
    };
    expect(projectPsc(statement, '00000006').controllers[0]?.name).toBe(
      'no-individual-or-entity-with-signficant-control'
    );
  });
});

describe('projectFilingHistory', () => {
  const raw = loadFixture('filing-history/filing-history.json');
  const result = projectFilingHistory(raw, '00000006');

  it('satisfies its own output schema', () => {
    expect(getFilingHistoryOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('reads total_count, which is what this endpoint calls it', () => {
    expect(result.pagination.total_results).toBe(3);
  });

  it('reports whether a document could be fetched', () => {
    expect(result.filings[0]?.has_document).toBe(true);
    expect(result.filings[1]?.has_document).toBe(false);
  });

  it('keeps the description key and its values together', () => {
    expect(result.filings[0]?.description).toBe('accounts-with-accounts-type-small');
    expect(result.filings[0]?.description_values).toEqual({ made_up_date: '2025-03-31' });
  });

  it('omits description_values entirely when there are none', () => {
    const bare = { items: [{ date: '2020-01-01', type: 'AA' }] };
    expect(projectFilingHistory(bare, '00000006').filings[0]?.description_values).toBeUndefined();
  });
});

describe('projectInsolvency', () => {
  const result = projectInsolvency(loadFixture('insolvency/insolvency-case.json'), 'SC123456');

  it('satisfies its own output schema', () => {
    expect(getInsolvencyOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('keeps the practitioners and their dates', () => {
    expect(result.case_count).toBe(1);
    expect(result.cases[0]?.practitioners).toHaveLength(2);
    expect(result.cases[0]?.practitioners[1]?.ceased_to_act_on).toBe('2024-02-02');
  });

  it('drops date entries that are missing half of themselves', () => {
    const partial = { cases: [{ type: 'administration', dates: [{ type: 'only-a-type' }] }] };
    expect(projectInsolvency(partial, 'SC123456').cases[0]?.dates).toEqual([]);
  });
});

describe('projectOfficerAppointments', () => {
  const result = projectOfficerAppointments(
    loadFixture('officers/appointments.json'),
    'aBcD1234EfGh5678IjKl'
  );

  it('satisfies its own output schema', () => {
    expect(getOfficerAppointmentsOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('counts active appointments, which is the conflict-check number', () => {
    expect(result.appointments).toHaveLength(3);
    expect(result.active_appointment_count).toBe(2);
  });

  it('reads the company out of appointed_to', () => {
    expect(result.appointments[0]?.company_number).toBe('00000006');
    expect(result.appointments[0]?.company_name).toBe('EXAMPLE FIXTURE TRADING LIMITED');
    expect(result.appointments[2]?.company_status).toBe('dissolved');
  });
});

describe('projectOfficerSearch', () => {
  it('extracts officer ids from the self link', () => {
    const result = projectOfficerSearch(loadFixture('search/officers.json'), 'alice fixture');
    expect(result.officers[0]?.officer_id).toBe('aBcD1234EfGh5678IjKl');
    expect(result.officers[0]?.appointment_count).toBe(3);
    expect(result.officers[1]?.date_of_birth).toBe('1988-11');
  });
});

describe('projection size', () => {
  const results = measure();

  // The README quotes a range. This test is what stops that range becoming a
  // claim nobody has checked since the day it was written. It guards against
  // regression; it does not assert a target that was never measured.
  it.each(results)('$name is smaller than the payload it came from', ({ ratio }) => {
    expect(ratio).toBeLessThan(0.75);
  });

  it('matches the range quoted in the README', () => {
    const best = Math.min(...results.map((result) => result.ratio));
    const worst = Math.max(...results.map((result) => result.ratio));

    expect(Math.round((1 - worst) * 100)).toBe(29);
    expect(Math.round((1 - best) * 100)).toBe(42);
  });
});
