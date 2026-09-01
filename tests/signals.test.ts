import { describe, expect, it } from 'vitest';

import { projectCharges, projectCompanyProfile, projectOfficers } from '../src/domain/projections.js';
import type { SignalCode } from '../src/domain/signals.js';
import { deriveSignals } from '../src/domain/signals.js';
import { loadFixture } from './helpers/support.js';

const NOW = Date.parse('2026-08-20T00:00:00.000Z');

const profileOf = (fixture: string) =>
  projectCompanyProfile(loadFixture(fixture), '04138203', NOW);

const codes = (signals: { code: SignalCode }[]): SignalCode[] => signals.map((signal) => signal.code);

describe('deriveSignals', () => {
  it('finds nothing on a clean, active company', () => {
    const profile = projectCompanyProfile(
      {
        company_name: 'CLEAN LIMITED',
        company_number: '00000006',
        company_status: 'active',
        date_of_creation: '2005-01-01',
        accounts: { overdue: false },
        confirmation_statement: { overdue: false },
        has_charges: false,
        has_insolvency_history: false
      },
      '00000006',
      NOW
    );

    expect(deriveSignals({ profile, now: NOW })).toEqual([]);
  });

  it('does not emit a score, a grade or a risk level', () => {
    // The absence is the design. A rating is a judgement about a real
    // business that this server has no standing to make, and once emitted it
    // gets quoted in meetings and stops being questioned.
    const profile = profileOf('company/profile-dissolved.json');
    const signals = deriveSignals({ profile, now: NOW });

    const serialised = JSON.stringify(signals);
    for (const forbidden of ['score', 'rating', 'grade', 'risk_level', 'severity', 'red', 'amber']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
    for (const signal of signals) {
      expect(Object.keys(signal).sort()).toEqual(['code', 'detail']);
    }
  });

  it('gives every signal a detail with the fact behind it', () => {
    const profile = profileOf('company/profile-dissolved.json');
    for (const signal of deriveSignals({ profile, now: NOW })) {
      expect(signal.detail.length).toBeGreaterThan(15);
      expect(signal.detail.endsWith('.')).toBe(true);
    }
  });

  it('reports a dissolved company with the date', () => {
    const signals = deriveSignals({ profile: profileOf('company/profile-dissolved.json'), now: NOW });
    expect(codes(signals)).toContain('dissolved');
    expect(signals.find((signal) => signal.code === 'dissolved')?.detail).toContain('2018-07-10');
  });

  it('separates formal insolvency proceedings from merely not being active', () => {
    const inLiquidation = projectCompanyProfile(
      { company_status: 'liquidation', company_name: 'X', company_number: '1' },
      '00000006',
      NOW
    );
    expect(codes(deriveSignals({ profile: inLiquidation, now: NOW }))).toContain('insolvency_proceedings');

    const converted = projectCompanyProfile(
      { company_status: 'converted-closed', company_name: 'X', company_number: '1' },
      '00000006',
      NOW
    );
    expect(codes(deriveSignals({ profile: converted, now: NOW }))).toContain('not_active');
  });

  it('reports overdue filings with the date they were due', () => {
    const profile = projectCompanyProfile(
      {
        company_status: 'active',
        company_name: 'LATE LIMITED',
        company_number: '00000006',
        accounts: { overdue: true, next_due: '2026-01-31' },
        confirmation_statement: { overdue: true, next_due: '2026-02-14' }
      },
      '00000006',
      NOW
    );
    const signals = deriveSignals({ profile, now: NOW });

    expect(codes(signals)).toEqual(
      expect.arrayContaining(['accounts_overdue', 'confirmation_statement_overdue'])
    );
    expect(signals.find((signal) => signal.code === 'accounts_overdue')?.detail).toContain('2026-01-31');
  });

  it('names who holds an outstanding charge, and only the outstanding ones', () => {
    const charges = projectCharges(loadFixture('charges/charges-outstanding.json'), '04138203');
    const signals = deriveSignals({ profile: profileOf('company/profile-active.json'), charges, now: NOW });

    const charge = signals.find((signal) => signal.code === 'outstanding_charges');
    expect(charge?.detail).toContain('2 outstanding charges');
    expect(charge?.detail).toContain('Rmcpp Trustees Limited');
    // A charge settled in 2022 is not something to raise with anybody.
    expect(charge?.detail).not.toContain('David Grant Hargrave');
  });

  it('reads the charges section rather than the profile flag', () => {
    // Royal Mail's profile reports has_charges: false while its charges
    // endpoint returns fifteen. The flag cannot be trusted and this signal
    // must never be rewired to use it.
    const charges = projectCharges(loadFixture('charges/charges-outstanding.json'), '04138203');
    const profile = profileOf('company/profile-active.json');

    expect(profile.flags.has_charges).toBe(false);
    expect(codes(deriveSignals({ profile, charges, now: NOW }))).toContain('outstanding_charges');
  });

  it('flags a floating charge only while it is outstanding', () => {
    // No charge in the recorded fixture declares that it covers everything, so
    // the positive case is constructed. The negative case below is the one
    // that matters: a settled floating charge must not raise anything.
    const outstanding = projectCharges(
      {
        total_count: 1,
        satisfied_count: 0,
        items: [
          {
            status: 'outstanding',
            particulars: { contains_floating_charge: true, floating_charge_covers_all: true }
          }
        ]
      },
      '04138203'
    );
    expect(
      codes(deriveSignals({ profile: profileOf('company/profile-active.json'), charges: outstanding, now: NOW }))
    ).toContain('floating_charge_over_all_assets');

    const settled = projectCharges(
      {
        total_count: 1,
        satisfied_count: 1,
        items: [
          {
            status: 'fully-satisfied',
            particulars: { contains_floating_charge: true, floating_charge_covers_all: true }
          }
        ]
      },
      '04138203'
    );
    expect(
      codes(deriveSignals({ profile: profileOf('company/profile-active.json'), charges: settled, now: NOW }))
    ).not.toContain('floating_charge_over_all_assets');
  });

  it('flags a company whose officers have all resigned', () => {
    const officers = projectOfficers(
      { items: [{ name: 'GONE, Person', officer_role: 'director', resigned_on: '2019-01-01' }] },
      '04138203',
      false
    );
    expect(
      codes(deriveSignals({ profile: profileOf('company/profile-active.json'), officers, now: NOW }))
    ).toContain('no_active_officers');
  });

  it('does not claim no active officers when the list is simply empty', () => {
    // An empty officers response means the page was empty, which is not the
    // same as every director having walked out.
    const officers = projectOfficers({ items: [] }, '04138203', false);
    expect(
      codes(deriveSignals({ profile: profileOf('company/profile-active.json'), officers, now: NOW }))
    ).not.toContain('no_active_officers');
  });

  it('counts resignations inside the last twelve months only', () => {
    const officers = projectOfficers(
      {
        items: [
          { name: 'STAYING, A', officer_role: 'director' },
          { name: 'RECENT, B', officer_role: 'director', resigned_on: '2026-06-01' },
          { name: 'OLD, C', officer_role: 'director', resigned_on: '2019-01-01' }
        ]
      },
      '04138203',
      false
    );
    const signals = deriveSignals({ profile: profileOf('company/profile-active.json'), officers, now: NOW });

    expect(signals.find((signal) => signal.code === 'recent_officer_departures')?.detail).toContain(
      '1 officer'
    );
  });

  it('flags a company incorporated within the last year', () => {
    const profile = projectCompanyProfile(
      { company_status: 'active', company_name: 'NEW LIMITED', company_number: '1', date_of_creation: '2026-05-01' },
      '00000006',
      NOW
    );
    expect(codes(deriveSignals({ profile, now: NOW }))).toContain('incorporated_within_last_year');
  });

  it('orders the most material observation first', () => {
    const profile = projectCompanyProfile(
      {
        company_status: 'dissolved',
        company_name: 'GONE LIMITED',
        company_number: '1',
        date_of_cessation: '2025-01-01',
        accounts: { overdue: true },
        registered_office_is_in_dispute: true
      },
      '00000006',
      NOW
    );
    const ordered = codes(deriveSignals({ profile, now: NOW }));

    expect(ordered[0]).toBe('dissolved');
    expect(ordered.at(-1)).toBe('registered_office_in_dispute');
  });

  it('reports insolvency history from either the profile flag or a real case', () => {
    const fromFlag = projectCompanyProfile(
      { company_status: 'active', company_name: 'X', company_number: '1', has_insolvency_history: true },
      '00000006',
      NOW
    );
    expect(codes(deriveSignals({ profile: fromFlag, now: NOW }))).toContain('insolvency_history');

    const fromCases = deriveSignals({
      profile: profileOf('company/profile-active.json'),
      insolvency: { company_number: '04138203', case_count: 2, cases: [] },
      now: NOW
    });
    expect(fromCases.find((signal) => signal.code === 'insolvency_history')?.detail).toContain('2 insolvency');
  });
});

describe('no_active_officers on a dissolved company', () => {
  // Recorded from Marine and General (00000006). Three of the five officers
  // have no resignation date because the company was dissolved out from under
  // them, and Companies House reports `active_count: 0`.
  const officers = projectOfficers(
    loadFixture('officers/officers-dissolved.json'),
    '00000006',
    false
  );
  const profile = projectCompanyProfile(
    loadFixture('company/profile-dissolved.json'),
    '00000006',
    NOW
  );

  it('fires, because there genuinely are none', () => {
    expect(codes(deriveSignals({ profile, officers, now: NOW }))).toContain('no_active_officers');
  });

  it('does not claim officers resigned when they never did', () => {
    // "Every officer has resigned" would be a confident false statement about
    // three named individuals.
    const signal = deriveSignals({ profile, officers, now: NOW }).find(
      (entry) => entry.code === 'no_active_officers'
    );

    expect(signal?.detail).toBe('The register shows no serving officers.');
  });

  it('still says so plainly when they really did all resign', () => {
    const walkedOut = projectOfficers(
      { items: [{ name: 'GONE, Person', officer_role: 'director', resigned_on: '2019-01-01' }] },
      '04138203',
      false
    );
    const signal = deriveSignals({
      profile: projectCompanyProfile(loadFixture('company/profile-active.json'), '04138203', NOW),
      officers: walkedOut,
      now: NOW
    }).find((entry) => entry.code === 'no_active_officers');

    expect(signal?.detail).toContain('has resigned');
  });
});
