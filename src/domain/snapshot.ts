import type { Body } from './projections.js';
import type {
  CompanySnapshotResult,
  GetChargesResult,
  GetCompanyResult,
  GetInsolvencyResult,
  GetOfficersResult
} from './schemas.js';
import { deriveSignals } from './signals.js';

/**
 * Assembles a snapshot from sections that have already been fetched and
 * projected.
 *
 * Keeping the assembly pure — no client, no network, no clock of its own —
 * means the interesting behaviour (what happens when a section is missing,
 * how signals fall out of a particular combination of facts) is testable
 * without scripting four HTTP responses for every case.
 */

export type SnapshotSection = 'profile' | 'officers' | 'charges' | 'insolvency';

export interface SectionFailure {
  section: SnapshotSection;
  code: string;
  message: string;
}

export interface SnapshotInput {
  profile: Body<GetCompanyResult>;
  officers?: Body<GetOfficersResult> | undefined;
  charges?: Body<GetChargesResult> | undefined;
  insolvency?: Body<GetInsolvencyResult> | undefined;
  /** Sections that were asked for, whether or not they arrived. */
  requested: SnapshotSection[];
  unavailable: SectionFailure[];
  now: number;
}

export function buildSnapshot(input: SnapshotInput): Body<CompanySnapshotResult> {
  const { profile, officers, charges, insolvency, unavailable, now } = input;

  const signals = deriveSignals({ profile, officers, charges, insolvency, now });

  const snapshot: Body<CompanySnapshotResult> = {
    company_number: profile.company_number,
    name: profile.name,
    status: profile.status,
    type_description: profile.type_description,
    incorporated_on: profile.incorporated_on,
    dissolved_on: profile.dissolved_on,
    age_years: profile.age_years,
    registered_office_address: profile.registered_office_address,
    sic_codes: profile.sic_codes,
    accounts: { next_due: profile.accounts.next_due, overdue: profile.accounts.overdue },
    confirmation_statement: {
      next_due: profile.confirmation_statement.next_due,
      overdue: profile.confirmation_statement.overdue
    },
    signals,
    // Signals can only reflect what was actually read. Publishing which
    // sections were included stops "no signals" being mistaken for "nothing
    // found" when the charges call never happened.
    sections_included: input.requested.filter(
      (section) => !unavailable.some((failure) => failure.section === section)
    ),
    sections_unavailable: unavailable
  };

  if (officers !== undefined) {
    snapshot.officers = {
      active_count: officers.active_count,
      resigned_count: officers.resigned_count,
      pagination: officers.pagination,
      // Resigned officers are the long tail of this list and are rarely the
      // question. Use get_officers with pagination to read the remaining pages.
      active: officers.officers
        .filter((officer) => officer.is_active)
        .map((officer) => ({
          name: officer.name,
          role: officer.role,
          officer_id: officer.officer_id,
          appointed_on: officer.appointed_on
        }))
    };
  }

  if (charges !== undefined) {
    snapshot.charges = {
      total_count: charges.total_count,
      outstanding_count: charges.outstanding_count,
      satisfied_count: charges.satisfied_count,
      part_satisfied_count: charges.part_satisfied_count,
      holders: [
        ...new Set(
          charges.charges
            .filter((charge) => charge.status !== 'fully-satisfied')
            .flatMap((charge) => charge.persons_entitled)
        )
      ]
    };
  }

  if (insolvency !== undefined) {
    snapshot.insolvency = {
      case_count: insolvency.case_count,
      types: [
        ...new Set(
          insolvency.cases
            .map((entry) => entry.type)
            .filter((type): type is string => type !== undefined)
        )
      ]
    };
  }

  return snapshot;
}
