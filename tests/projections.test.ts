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

/**
 * These run against fixtures recorded from the live Companies House API.
 *
 * The subjects are Royal Mail Group Limited (04138203) for an active company,
 * Marine and General Mutual Life Assurance Society (00000006) for a dissolved
 * one, and Carillion PLC (03782379) for insolvency. Real values are asserted
 * where they demonstrate what the projection does; anything that would merely
 * restate the fixture back to itself is asserted as a relationship instead.
 */

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
  const raw = loadFixture<Record<string, unknown>>('company/profile-active.json');
  const result = projectCompanyProfile(raw, '04138203', NOW);

  it('satisfies its own output schema', () => {
    expect(getCompanyOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('flattens the registered office into one line, in postal order', () => {
    expect(result.registered_office_address).toBe(
      '185 Farringdon Road, London, EC1A 1AA, United Kingdom'
    );
  });

  it('translates the type slug into words', () => {
    expect(result.type).toBe('ltd');
    expect(result.type_description).toBe('Private limited company');
  });

  it('derives age in whole years from the incorporation date', () => {
    expect(result.incorporated_on).toBe('2001-01-10');
    expect(result.age_years).toBe(25);
    expect(result.flags.incorporated_within_last_year).toBe(false);
  });

  it('reads the last accounts date out of its nested home', () => {
    // `accounts.last_accounts.made_up_to`, lifted to the top of the section.
    expect(result.accounts.last_made_up_to).toBe('2025-03-30');
    expect(result.accounts.next_due).toBe('2026-12-28');
  });

  it('derives the filing flags rather than handing dates to the caller', () => {
    expect(result.flags.is_active).toBe(true);
    expect(result.flags.accounts_overdue).toBe(false);
    expect(result.flags.confirmation_statement_overdue).toBe(false);
  });

  it('drops the structure nobody reads', () => {
    const serialised = JSON.stringify(result);
    for (const noise of ['"links"', '"etag"', '"kind"', '"person_number"', '"is_pre_1992']) {
      expect(serialised).not.toContain(noise);
    }
    // `can_file` is kept, deliberately — it is one of the derived flags.
    expect(result.flags.can_file).toBeDefined();
  });

  it('reports a dissolved company with its cessation date', () => {
    const dissolved = projectCompanyProfile(
      loadFixture('company/profile-dissolved.json'),
      '00000006',
      NOW
    );

    expect(dissolved.name).toBe('MARINE AND GENERAL MUTUAL LIFE ASSURANCE SOCIETY');
    expect(dissolved.status).toBe('dissolved');
    expect(dissolved.flags.is_active).toBe(false);
    expect(dissolved.dissolved_on).toBe('2018-07-10');
  });

  it('defaults an absent boolean to false rather than dropping the flag', () => {
    // The dissolved company's profile omits has_been_liquidated entirely. The
    // flag still has to be present and answerable.
    const dissolved = projectCompanyProfile(
      loadFixture('company/profile-dissolved.json'),
      '00000006',
      NOW
    );
    expect(dissolved.flags.has_been_liquidated).toBe(false);
    expect(dissolved.accounts.overdue).toBeUndefined();
  });

  it('survives an empty payload rather than throwing', () => {
    // Reading upstream loosely is the whole point: a field we do not get is a
    // field that is missing, not an outage.
    const empty = projectCompanyProfile({}, '04138203', NOW);
    expect(empty.company_number).toBe('04138203');
    expect(empty.flags.is_active).toBe(false);
    expect(getCompanyOutput.safeParse({ ...empty, meta }).success).toBe(true);
  });

  it('survives a payload with wrong-typed fields', () => {
    const odd = projectCompanyProfile(
      { company_name: 42, sic_codes: 'not-an-array', accounts: null, has_charges: 'yes' },
      '04138203',
      NOW
    );
    expect(odd.sic_codes).toEqual([]);
    expect(odd.flags.has_charges).toBe(false);
    expect(getCompanyOutput.safeParse({ ...odd, meta }).success).toBe(true);
  });
});

describe('the profile has_charges flag is not trustworthy', () => {
  it('says false for a company that has fifteen charges', () => {
    // Found while recording real fixtures. Royal Mail's profile reports
    // has_charges: false; its charges endpoint returns fifteen, two of them
    // outstanding. Nothing here can fix the upstream flag, so the rule is that
    // the charges section is authoritative and the flag is never the basis for
    // a signal. This test exists to stop anyone "simplifying" the signal code
    // to read the flag instead.
    const profile = projectCompanyProfile(
      loadFixture('company/profile-active.json'),
      '04138203',
      NOW
    );
    const charges = projectCharges(loadFixture('charges/charges-outstanding.json'), '04138203');

    expect(profile.flags.has_charges).toBe(false);
    expect(charges.total_count).toBe(15);
    expect(charges.outstanding_count).toBeGreaterThan(0);
  });
});

describe('projectCompanySearch', () => {
  const raw = loadFixture('search/companies.json');

  it('marks an exact name match and calls off disambiguation', () => {
    const result = projectCompanySearch(raw, 'royal mail limited');
    expect(result.exact_name_match).toBe('14240638');
    expect(result.disambiguation_needed).toBe(false);
  });

  it('asks for disambiguation when several near-misses come back', () => {
    const result = projectCompanySearch(raw, 'royal mail');
    expect(result.exact_name_match).toBeUndefined();
    expect(result.disambiguation_needed).toBe(true);
    expect(result.companies.length).toBeGreaterThan(1);
  });

  it('reports the full result count, not just the page', () => {
    const result = projectCompanySearch(raw, 'royal mail');
    expect(result.pagination.returned).toBe(5);
    expect(result.pagination.total_results).toBe(7139);
    expect(result.pagination.has_more).toBe(true);
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
    const result = projectOfficers(raw, '04138203', false);
    expect(getOfficersOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('extracts the officer id, which the API only exposes inside a URL', () => {
    // The single most valuable thing this projection does: without it, a
    // caller who has just listed a board cannot look any of them up.
    const result = projectOfficers(raw, '04138203', false);
    expect(result.officers[0]?.officer_id).toBe('vKBmO0VKB84EFn2fjjCSWgLFHbY');
    for (const officer of result.officers) {
      expect(officer.officer_id, `${officer.name} has no officer id`).toBeDefined();
    }
  });

  it('carries the counts for the whole register, not just this page', () => {
    const result = projectOfficers(raw, '04138203', false);
    expect(result.officers).toHaveLength(5);
    expect(result.active_count).toBe(10);
    expect(result.resigned_count).toBe(54);
    expect(result.pagination.has_more).toBe(true);
  });

  it('renders a partial date of birth without pretending to know the day', () => {
    const result = projectOfficers(raw, '04138203', false);
    const withDob = result.officers.find((officer) => officer.date_of_birth !== undefined);
    expect(withDob?.date_of_birth).toMatch(/^\d{4}-\d{2}$/);
  });

  it('leaves date of birth absent where the register has none', () => {
    // Company secretaries are filed without one.
    const result = projectOfficers(raw, '04138203', false);
    expect(result.officers[0]?.role).toBe('secretary');
    expect(result.officers[0]?.date_of_birth).toBeUndefined();
  });

  it('marks a resigned officer inactive', () => {
    const result = projectOfficers(
      { items: [{ name: 'GONE, Person', officer_role: 'director', resigned_on: '2019-01-01' }] },
      '04138203',
      false
    );
    expect(result.officers[0]?.is_active).toBe(false);
  });

  it('withholds service addresses unless verbose was asked for', () => {
    const quiet = projectOfficers(raw, '04138203', false);
    expect(quiet.officers.every((officer) => officer.address === undefined)).toBe(true);

    const verbose = projectOfficers(raw, '04138203', true);
    expect(verbose.officers[0]?.address).toContain('Farringdon Road');
  });
});

describe('projectOfficers on a dissolved company', () => {
  // Recorded from Marine and General Mutual Life Assurance Society (00000006),
  // dissolved 2018. Found by running the deployed server against the live
  // register: the shaped answer said `active_count: 0` and then listed three
  // active officers underneath it.
  const raw = loadFixture('officers/officers-dissolved.json');

  it('trusts the register\'s own count over the absence of a resignation date', () => {
    // Nobody resigns from a company that was dissolved out from under them, so
    // `resigned_on` stays empty forever and the inference says they are still
    // serving. Companies House counts them a third way -- 0 active, 49
    // resigned, 3 inactive of 52 -- and its count is the authority.
    const result = projectOfficers(raw, '00000006', false);

    expect(result.active_count).toBe(0);
    expect(result.officers.filter((officer) => officer.is_active)).toHaveLength(0);
  });

  it('still reports the officers themselves, and when they resigned', () => {
    // The fix is about the `is_active` claim, not about hiding anybody. Three
    // of these five never resigned; two did, and those dates are still right.
    const result = projectOfficers(raw, '00000006', false);

    expect(result.officers).toHaveLength(5);
    expect(result.officers.filter((o) => o.resigned_on !== undefined)).toHaveLength(2);
  });

  it('reports inactive_count, so the numbers add up', () => {
    // Without it a caller sees 0 active and 49 resigned out of 52 results and
    // has no way to account for the missing three -- which are exactly the
    // records that made the old inference wrong.
    const result = projectOfficers(raw, '00000006', false);

    expect(result.inactive_count).toBe(3);
    expect((result.active_count ?? 0) + (result.resigned_count ?? 0) + (result.inactive_count ?? 0))
      .toBe(result.pagination.total_results);
  });

  it('leaves a live company alone', () => {
    // The reconciliation applies only to a zero count. A non-zero count above a
    // shorter list is not a contradiction -- the list is one page of many -- and
    // treating it as one would silently blank the officers of every company
    // whose board does not fit on the first page.
    const live = projectOfficers(loadFixture('officers/officers-list.json'), '04138203', false);

    expect(live.active_count).toBe(10);
    expect(live.officers.filter((officer) => officer.is_active).length).toBeGreaterThan(0);
  });
});

describe('projectCharges', () => {
  const raw = loadFixture('charges/charges-outstanding.json');
  const result = projectCharges(raw, '04138203');

  it('satisfies its own output schema', () => {
    expect(getChargesOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('derives the outstanding count the API never reports', () => {
    expect(result.total_count).toBe(15);
    expect(result.satisfied_count).toBe(13);
    expect(result.part_satisfied_count).toBe(0);
    expect(result.outstanding_count).toBe(2);
  });

  it('never reports a negative outstanding count', () => {
    const inconsistent = { total_count: 1, satisfied_count: 3, part_satisfied_count: 1, items: [] };
    expect(projectCharges(inconsistent, '04138203').outstanding_count).toBe(0);
  });

  it('lifts the lender out of the nested persons_entitled list', () => {
    expect(result.charges[0]?.status).toBe('outstanding');
    expect(result.charges[0]?.persons_entitled).toEqual(['Rmcpp Trustees Limited']);
  });

  it('keeps the classification but drops the filing transactions', () => {
    // Real charge records carry a `transactions` array of filing links, which
    // is provenance rather than an answer to anything.
    expect(result.charges[0]?.classification).toBe('A registered charge');
    expect(JSON.stringify(result)).not.toContain('transactions');
  });

  it('leaves the floating-charge flags absent when the register omits them', () => {
    expect(result.charges.every((charge) => charge.floating_charge_covers_all === undefined)).toBe(true);
  });
});

describe('projectPsc', () => {
  const raw = loadFixture('psc/psc-list.json');
  const result = projectPsc(raw, '04138203');

  it('satisfies its own output schema', () => {
    expect(getPscOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('marks a ceased interest inactive and keeps the date', () => {
    const ceased = result.controllers.find((controller) => !controller.is_active);
    expect(ceased?.name).toBe('Royal Mail Plc');
    expect(ceased?.ceased_on).toBe('2021-08-31');
    expect(result.controllers.some((controller) => controller.is_active)).toBe(true);
  });

  it('keeps the natures of control, which is the answer people want', () => {
    const active = result.controllers.find((controller) => controller.is_active);
    expect(active?.natures_of_control).toContain('ownership-of-shares-75-to-100-percent');
    expect(active?.kind).toBe('corporate-entity-person-with-significant-control');
  });

  it('falls back to the statement when no person is named', () => {
    // A company that cannot identify a controller files a statement instead,
    // and that record has no name field at all.
    const statement = {
      items: [
        {
          kind: 'persons-with-significant-control-statement',
          statement: 'no-individual-or-entity-with-signficant-control',
          notified_on: '2017-07-01'
        }
      ]
    };
    expect(projectPsc(statement, '04138203').controllers[0]?.name).toBe(
      'no-individual-or-entity-with-signficant-control'
    );
  });
});

describe('projectFilingHistory', () => {
  const raw = loadFixture('filing-history/filing-history.json');
  const result = projectFilingHistory(raw, '04138203');

  it('satisfies its own output schema', () => {
    expect(getFilingHistoryOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('reads total_count, which is what this endpoint calls it', () => {
    expect(result.filings).toHaveLength(5);
    expect(result.pagination.total_results).toBe(284);
    expect(result.pagination.has_more).toBe(true);
  });

  it('reports whether a filed document could be fetched', () => {
    expect(result.filings[0]?.has_document).toBe(true);
    const noDocument = projectFilingHistory({ items: [{ date: '2020-01-01', type: 'AA' }] }, '04138203');
    expect(noDocument.filings[0]?.has_document).toBe(false);
  });

  it('keeps the description key untranslated, with its values', () => {
    // Rendering `termination-director-company-with-name-termination-date` into
    // English needs a template file Companies House ships separately. A
    // partial local translation would render some filings wrongly and nobody
    // would be able to tell which.
    expect(result.filings[0]?.category).toBe('officers');
    expect(result.filings[0]?.type).toBe('TM01');
    expect(result.filings[0]?.description).toBe(
      'termination-director-company-with-name-termination-date'
    );
    expect(Object.keys(result.filings[0]?.description_values ?? {}).length).toBeGreaterThan(0);
  });

  it('omits description_values entirely when there are none', () => {
    const bare = { items: [{ date: '2020-01-01', type: 'AA' }] };
    expect(projectFilingHistory(bare, '04138203').filings[0]?.description_values).toBeUndefined();
  });
});

describe('projectInsolvency', () => {
  const result = projectInsolvency(loadFixture('insolvency/insolvency-case.json'), '03782379');

  it('satisfies its own output schema', () => {
    expect(getInsolvencyOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('keeps the case type, its dates and the practitioner', () => {
    expect(result.case_count).toBe(1);
    expect(result.cases[0]?.type).toBe('compulsory-liquidation');
    expect(result.cases[0]?.dates.map((entry) => entry.type)).toContain('wound-up-on');
    expect(result.cases[0]?.practitioners[0]?.name).toBe('The Official Receiver Or London');
  });

  it('drops date entries that are missing half of themselves', () => {
    const partial = { cases: [{ type: 'administration', dates: [{ type: 'only-a-type' }] }] };
    expect(projectInsolvency(partial, '03782379').cases[0]?.dates).toEqual([]);
  });
});

describe('projectOfficerAppointments', () => {
  const raw = loadFixture('officers/appointments.json');
  const result = projectOfficerAppointments(raw, 'gBfDMtBVo3nHfig_wVfjaOA9o1M');

  it('satisfies its own output schema', () => {
    expect(getOfficerAppointmentsOutput.safeParse({ ...result, meta }).success).toBe(true);
  });

  it('counts active appointments, which is the conflict-check number', () => {
    expect(result.name).toBe('Paul ABLIN');
    expect(result.appointments).toHaveLength(9);
    expect(result.active_appointment_count).toBe(8);
  });

  it('reads the company out of appointed_to', () => {
    const royalMail = result.appointments.find(
      (appointment) => appointment.company_number === '04138203'
    );
    expect(royalMail?.company_name).toBe('ROYAL MAIL GROUP LIMITED');
    expect(royalMail?.company_status).toBe('active');
    expect(royalMail?.is_active).toBe(true);
  });

  it('marks a resigned appointment inactive', () => {
    const resigned = result.appointments.find((appointment) => !appointment.is_active);
    expect(resigned?.resigned_on).toBe('2019-09-19');
  });
});

describe('projectOfficerAppointments across a dissolved company', () => {
  // Recorded from a director of Marine and General (00000006), dissolved 2018.
  // The live 0.3.0 deployment returned `company_status: "dissolved"` and
  // `is_active: true` on the same row, and counted it as his one current
  // appointment. Companies House's own payload says `active_count: 0`.
  const raw = loadFixture('officers/appointments-dissolved.json');

  it('does not call somebody a serving director of a dissolved company', () => {
    const result = projectOfficerAppointments(raw, 'I-4OI1Rt7bqjbeWflGDl_s6KG6s');
    const marineAndGeneral = result.appointments.find((a) => a.company_number === '00000006');

    expect(marineAndGeneral?.company_status).toBe('dissolved');
    expect(marineAndGeneral?.resigned_on).toBeUndefined();
    // Never resigned, because there was nothing left to resign from.
    expect(marineAndGeneral?.is_active).toBe(false);
  });

  it('agrees with the register on how many appointments are current', () => {
    // This is the conflict-of-interest tool: "how many companies is this person
    // running" is the question it exists to answer, and the old answer was one
    // company that has not existed since 2018.
    const result = projectOfficerAppointments(raw, 'I-4OI1Rt7bqjbeWflGDl_s6KG6s');

    expect(result.active_appointment_count).toBe(0);
    expect(raw).toMatchObject({ active_count: 0 });
  });

  it('still counts a live company the person never resigned from', () => {
    // The guard keys on the company being gone, not on it being troubled.
    // Liquidation and administration are deliberately not in that set: those
    // companies still exist and their directors are still serving, which is
    // precisely when somebody screening them wants the name.
    const live = {
      ...(raw as Record<string, unknown>),
      items: [
        {
          appointed_on: '2015-03-01',
          appointed_to: {
            company_name: 'STILL TRADING LIMITED',
            company_number: '99999999',
            company_status: 'liquidation'
          },
          name: 'James GALBRAITH',
          officer_role: 'director'
        }
      ]
    };
    const result = projectOfficerAppointments(live, 'I-4OI1Rt7bqjbeWflGDl_s6KG6s');

    expect(result.appointments[0]?.is_active).toBe(true);
  });
});

describe('projectOfficerSearch', () => {
  const result = projectOfficerSearch(loadFixture('search/officers.json'), 'smith');

  it('extracts officer ids from the self link', () => {
    expect(result.officers).toHaveLength(5);
    for (const officer of result.officers) {
      expect(officer.officer_id, `${officer.name} has no officer id`).toBeDefined();
    }
  });

  it('keeps the appointment count, which is what separates namesakes', () => {
    expect(result.officers[0]?.appointment_count).toBeGreaterThan(0);
  });
});

describe('projection size', () => {
  const results = measure();

  // The README quotes a range. This test is what stops that range becoming a
  // claim nobody has checked since the day it was written. It guards against
  // regression; it does not assert a target that was never measured.
  it.each(results)('$name is smaller than the payload it came from', ({ ratio }) => {
    expect(ratio).toBeLessThan(0.7);
  });

  it('matches the range quoted in the README', () => {
    const best = Math.min(...results.map((result) => result.ratio));
    const worst = Math.max(...results.map((result) => result.ratio));

    expect(Math.round((1 - worst) * 100)).toBe(36);
    expect(Math.round((1 - best) * 100)).toBe(72);
  });
});
