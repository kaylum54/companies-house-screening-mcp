import { describe, expect, it } from 'vitest';

import { projectCharges, projectCompanyProfile, projectOfficers } from '../src/domain/projections.js';
import type { SignalCode } from '../src/domain/signals.js';
import { deriveSignals } from '../src/domain/signals.js';
import { loadFixture } from './helpers/support.js';

const NOW = Date.parse('2026-08-20T00:00:00.000Z');

const profileOf = (fixture: string) =>
  projectCompanyProfile(loadFixture(fixture), '00000006', NOW);

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
    expect(signals.find((signal) => signal.code === 'dissolved')?.detail).toContain('2024-01-16');
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

  it('names who holds an outstanding charge', () => {
    const charges = projectCharges(loadFixture('charges/charges-outstanding.json'), '00000006');
    const signals = deriveSignals({ profile: profileOf('company/profile-active.json'), charges, now: NOW });

    const charge = signals.find((signal) => signal.code === 'outstanding_charges');
    expect(charge?.detail).toContain('EXAMPLE FIXTURE BANK PLC');
    expect(charge?.detail).not.toContain('EXAMPLE FIXTURE ASSET FINANCE');
  });

  it('flags a floating charge only while it is outstanding', () => {
    const charges = projectCharges(loadFixture('charges/charges-outstanding.json'), '00000006');
    expect(
      codes(deriveSignals({ profile: profileOf('company/profile-active.json'), charges, now: NOW }))
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
      '00000006'
    );
    expect(
      codes(deriveSignals({ profile: profileOf('company/profile-active.json'), charges: settled, now: NOW }))
    ).not.toContain('floating_charge_over_all_assets');
  });

  it('flags a company whose officers have all resigned', () => {
    const officers = projectOfficers(
      { items: [{ name: 'GONE, Person', officer_role: 'director', resigned_on: '2019-01-01' }] },
      '00000006',
      false
    );
    expect(
      codes(deriveSignals({ profile: profileOf('company/profile-active.json'), officers, now: NOW }))
    ).toContain('no_active_officers');
  });

  it('does not claim no active officers when the list is simply empty', () => {
    // An empty officers response means the page was empty, which is not the
    // same as every director having walked out.
    const officers = projectOfficers({ items: [] }, '00000006', false);
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
      '00000006',
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
      insolvency: { company_number: '00000006', case_count: 2, cases: [] },
      now: NOW
    });
    expect(fromCases.find((signal) => signal.code === 'insolvency_history')?.detail).toContain('2 insolvency');
  });
});
