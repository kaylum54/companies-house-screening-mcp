import type { Body } from './projections.js';
import type {
  GetChargesResult,
  GetCompanyResult,
  GetInsolvencyResult,
  GetOfficersResult
} from './schemas.js';

/**
 * Signals, not scores.
 *
 * The obvious thing to put on a snapshot is a rating — green, amber, red, or
 * a number out of a hundred. It is deliberately absent, and that absence is
 * the most important design decision in this file.
 *
 * A rating is a judgement about a real business, and this server has no
 * standing to make one. It cannot see the bank balance, the order book, the
 * parent guarantee or the reason the accounts are late. A company can be
 * three weeks overdue on filings because its accountant is ill, and it can be
 * perfectly current on filings the month before it collapses. Compressing
 * that into "high risk" produces a number people quote in meetings and stop
 * questioning, and the person on the other end of it — a real company with
 * real staff — never finds out why they were dropped.
 *
 * So this emits facts, each one traceable to a field on the register, and
 * leaves the judgement where it belongs. `signals` being empty means nothing
 * on this list was found; it does not mean the company is sound.
 *
 * See docs/adr/0007-signals-not-scores.md.
 */

export const SIGNAL_CODES = [
  'dissolved',
  'insolvency_proceedings',
  'not_active',
  'insolvency_history',
  'accounts_overdue',
  'confirmation_statement_overdue',
  'outstanding_charges',
  'floating_charge_over_all_assets',
  'no_active_officers',
  'recent_officer_departures',
  'incorporated_within_last_year',
  'registered_office_in_dispute'
] as const;

export type SignalCode = (typeof SIGNAL_CODES)[number];

export interface Signal {
  code: SignalCode;
  detail: string;
}

/** Statuses that mean a formal insolvency process is under way. */
const INSOLVENCY_STATUSES = new Set([
  'liquidation',
  'receivership',
  'administration',
  'voluntary-arrangement',
  'insolvency-proceedings'
]);

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface SignalInput {
  profile: Body<GetCompanyResult>;
  officers?: Body<GetOfficersResult> | undefined;
  charges?: Body<GetChargesResult> | undefined;
  insolvency?: Body<GetInsolvencyResult> | undefined;
  now: number;
}

/**
 * Derives the signal list.
 *
 * Order is materiality as a human reader would rank it — a dissolved company
 * first, a disputed registered office last. It is an ordering, not a scoring:
 * nothing here combines two signals into a third, and nothing weights them.
 */
export function deriveSignals(input: SignalInput): Signal[] {
  const { profile, officers, charges, insolvency, now } = input;
  const signals: Signal[] = [];
  const status = profile.status;

  if (status === 'dissolved') {
    signals.push({
      code: 'dissolved',
      detail:
        profile.dissolved_on === undefined
          ? 'The company is dissolved.'
          : `The company was dissolved on ${profile.dissolved_on}.`
    });
  } else if (status !== undefined && INSOLVENCY_STATUSES.has(status)) {
    signals.push({ code: 'insolvency_proceedings', detail: `Company status is "${status}".` });
  } else if (status !== undefined && status !== 'active') {
    signals.push({ code: 'not_active', detail: `Company status is "${status}" rather than active.` });
  }

  const caseCount = insolvency?.case_count ?? 0;
  if (profile.flags.has_insolvency_history || caseCount > 0) {
    signals.push({
      code: 'insolvency_history',
      detail:
        caseCount > 0
          ? `${caseCount} insolvency ${caseCount === 1 ? 'case is' : 'cases are'} recorded against the company.`
          : 'The register records insolvency history for this company.'
    });
  }

  if (profile.flags.accounts_overdue) {
    signals.push({
      code: 'accounts_overdue',
      detail:
        profile.accounts.next_due === undefined
          ? 'Accounts are overdue.'
          : `Accounts were due on ${profile.accounts.next_due} and are overdue.`
    });
  }

  if (profile.flags.confirmation_statement_overdue) {
    signals.push({
      code: 'confirmation_statement_overdue',
      detail:
        profile.confirmation_statement.next_due === undefined
          ? 'The confirmation statement is overdue.'
          : `The confirmation statement was due on ${profile.confirmation_statement.next_due} and is overdue.`
    });
  }

  if (charges !== undefined && charges.outstanding_count > 0) {
    const holders = [
      ...new Set(
        charges.charges
          .filter((charge) => charge.status !== 'fully-satisfied')
          .flatMap((charge) => charge.persons_entitled)
      )
    ];
    signals.push({
      code: 'outstanding_charges',
      detail:
        holders.length === 0
          ? `${charges.outstanding_count} outstanding ${charges.outstanding_count === 1 ? 'charge' : 'charges'} registered.`
          : `${charges.outstanding_count} outstanding ${charges.outstanding_count === 1 ? 'charge' : 'charges'} registered, held by ${holders.join(', ')}.`
    });

    if (
      charges.charges.some(
        (charge) => charge.status !== 'fully-satisfied' && charge.floating_charge_covers_all === true
      )
    ) {
      signals.push({
        code: 'floating_charge_over_all_assets',
        detail: 'An outstanding floating charge covers all the property or undertaking of the company.'
      });
    }
  }

  if (officers !== undefined) {
    const active = officers.officers.filter((officer) => officer.is_active);
    if (officers.officers.length > 0 && active.length === 0) {
      signals.push({
        code: 'no_active_officers',
        detail: 'Every officer on the register has resigned; the company has no serving directors.'
      });
    }

    const recentlyDeparted = officers.officers.filter((officer) => {
      if (officer.resigned_on === undefined) return false;
      const resigned = Date.parse(officer.resigned_on);
      return Number.isFinite(resigned) && now - resigned <= YEAR_MS;
    });
    if (recentlyDeparted.length > 0) {
      signals.push({
        code: 'recent_officer_departures',
        detail: `${recentlyDeparted.length} officer${recentlyDeparted.length === 1 ? '' : 's'} resigned in the last twelve months.`
      });
    }
  }

  if (profile.flags.incorporated_within_last_year) {
    signals.push({
      code: 'incorporated_within_last_year',
      detail:
        profile.incorporated_on === undefined
          ? 'The company was incorporated within the last year.'
          : `The company was incorporated on ${profile.incorporated_on}, within the last year.`
    });
  }

  if (profile.registered_office_in_dispute === true) {
    signals.push({
      code: 'registered_office_in_dispute',
      detail: 'The registered office address is recorded as being in dispute.'
    });
  }

  return signals;
}
