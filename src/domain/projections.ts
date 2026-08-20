import {
  describeCompanyType,
  formatAddress,
  formatPartialDateOfBirth,
  officerIdFromItem,
  pagination,
  personsEntitled,
  yearsSince
} from './format.js';
import { arr, bool, num, obj, path, str } from './read.js';
import type {
  FindCompanyResult,
  FindOfficerResult,
  GetChargesResult,
  GetCompanyResult,
  GetFilingHistoryResult,
  GetInsolvencyResult,
  GetOfficerAppointmentsResult,
  GetOfficersResult,
  GetPscResult
} from './schemas.js';

/**
 * Raw Companies House payloads to the shapes this server emits.
 *
 * Two things happen here, and both are the point of the server rather than
 * incidental to it:
 *
 * 1. **Shrinking.** `links`, `etag`, `kind` and nine-key address objects are
 *    never read by a model, so they are dropped. Measured against the current
 *    fixtures this saves between 29% and 42%, depending on the endpoint — a
 *    useful cut rather than a dramatic one, because the derived fields added
 *    here cost some of it back. `scripts/measure-projections.ts` prints the
 *    table and a test holds it to those numbers.
 *
 * 2. **Deriving.** "Are the accounts overdue", "how old is this company",
 *    "how many charges are outstanding" are the questions people actually ask.
 *    Computing them once, here, beats asking a model to work them out from
 *    dates on every call — models are worse at date arithmetic than this file
 *    is, and they are not consistent about it between calls.
 */

/** Everything a tool returns except the `meta` and `raw` envelope. */
export type Body<T> = Omit<T, 'meta' | 'raw'>;

const isActive = (resignedOrCeased: string | undefined): boolean => resignedOrCeased === undefined;

/** Search hits differ in shape between /search/companies and /advanced-search/companies. */
function companySummary(item: unknown): Body<FindCompanyResult>['companies'][number] | undefined {
  const source = obj(item);
  const companyNumber = str(source['company_number']);
  const name = str(source['title']) ?? str(source['company_name']);
  if (companyNumber === undefined || name === undefined) return undefined;

  return {
    company_number: companyNumber,
    name,
    status: str(source['company_status']),
    type: str(source['company_type']),
    type_description: describeCompanyType(source['company_type']),
    incorporated_on: str(source['date_of_creation']),
    dissolved_on: str(source['date_of_cessation']),
    address:
      str(source['address_snippet']) ??
      formatAddress(source['registered_office_address']) ??
      formatAddress(source['address'])
  };
}

const normaliseName = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

export function projectCompanySearch(payload: unknown, query: string): Body<FindCompanyResult> {
  const companies = arr(obj(payload)['items'])
    .map(companySummary)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  const wanted = normaliseName(query);
  const exact = companies.find((company) => normaliseName(company.name) === wanted);

  return {
    query,
    companies,
    exact_name_match: exact?.company_number,
    // One result is not ambiguous. An exact name match is not ambiguous. Two
    // near-misses are, and saying so is what stops a model picking the first
    // row and presenting it as fact.
    disambiguation_needed: companies.length > 1 && exact === undefined,
    pagination: pagination(payload, companies.length)
  };
}

export function projectOfficerSearch(payload: unknown, query: string): Body<FindOfficerResult> {
  const officers = arr(obj(payload)['items'])
    .map((item) => {
      const source = obj(item);
      const name = str(source['title']) ?? str(source['name']);
      if (name === undefined) return undefined;
      return {
        officer_id: officerIdFromItem(item),
        name,
        appointment_count: num(source['appointment_count']),
        date_of_birth: formatPartialDateOfBirth(source['date_of_birth']),
        address: str(source['address_snippet']) ?? formatAddress(source['address'])
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  return { query, officers, pagination: pagination(payload, officers.length) };
}

export function projectCompanyProfile(
  payload: unknown,
  companyNumber: string,
  now: number
): Body<GetCompanyResult> {
  const source = obj(payload);
  const status = str(source['company_status']);
  const incorporatedOn = str(source['date_of_creation']);
  const ageYears = yearsSince(incorporatedOn, now);

  const accounts = obj(source['accounts']);
  const confirmation = obj(source['confirmation_statement']);
  const accountsOverdue = bool(accounts['overdue']) ?? false;
  const statementOverdue = bool(confirmation['overdue']) ?? false;

  return {
    company_number: str(source['company_number']) ?? companyNumber,
    name: str(source['company_name']) ?? '(name not returned)',
    status,
    status_detail: str(source['company_status_detail']),
    type: str(source['type']),
    type_description: describeCompanyType(source['type']),
    jurisdiction: str(source['jurisdiction']),
    incorporated_on: incorporatedOn,
    dissolved_on: str(source['date_of_cessation']),
    age_years: ageYears,
    registered_office_address: formatAddress(source['registered_office_address']),
    registered_office_in_dispute: bool(source['registered_office_is_in_dispute']),
    sic_codes: arr(source['sic_codes'])
      .map((code) => str(code))
      .filter((code): code is string => code !== undefined),
    accounts: {
      next_due: str(accounts['next_due']),
      next_made_up_to: str(accounts['next_made_up_to']),
      last_made_up_to: str(path(accounts, 'last_accounts', 'made_up_to')),
      overdue: bool(accounts['overdue'])
    },
    confirmation_statement: {
      next_due: str(confirmation['next_due']),
      next_made_up_to: str(confirmation['next_made_up_to']),
      last_made_up_to: str(confirmation['last_made_up_to']),
      overdue: bool(confirmation['overdue'])
    },
    flags: {
      is_active: status === 'active',
      accounts_overdue: accountsOverdue,
      confirmation_statement_overdue: statementOverdue,
      has_charges: bool(source['has_charges']) ?? false,
      has_insolvency_history: bool(source['has_insolvency_history']) ?? false,
      has_been_liquidated: bool(source['has_been_liquidated']) ?? false,
      // A company incorporated last month with a large invoice is a pattern
      // worth flagging on its own, so it is computed rather than left to the
      // caller to spot from a date.
      incorporated_within_last_year: ageYears !== undefined && ageYears < 1,
      can_file: bool(source['can_file'])
    }
  };
}

export function projectOfficers(
  payload: unknown,
  companyNumber: string,
  includeAddresses: boolean
): Body<GetOfficersResult> {
  const source = obj(payload);
  const officers = arr(source['items'])
    .map((item) => {
      const entry = obj(item);
      const name = str(entry['name']);
      if (name === undefined) return undefined;
      const resignedOn = str(entry['resigned_on']);
      return {
        officer_id: officerIdFromItem(item),
        name,
        role: str(entry['officer_role']),
        appointed_on: str(entry['appointed_on']),
        resigned_on: resignedOn,
        is_active: isActive(resignedOn),
        nationality: str(entry['nationality']),
        country_of_residence: str(entry['country_of_residence']),
        occupation: str(entry['occupation']),
        date_of_birth: formatPartialDateOfBirth(entry['date_of_birth']),
        // Service addresses are personal data and are large. They are withheld
        // unless the caller explicitly asked for the verbose form.
        address: includeAddresses ? formatAddress(entry['address']) : undefined
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  return {
    company_number: companyNumber,
    active_count: num(source['active_count']),
    resigned_count: num(source['resigned_count']),
    officers,
    pagination: pagination(payload, officers.length)
  };
}

export function projectFilingHistory(
  payload: unknown,
  companyNumber: string
): Body<GetFilingHistoryResult> {
  const filings = arr(obj(payload)['items']).map((item) => {
    const entry = obj(item);
    const values = obj(entry['description_values']);
    return {
      date: str(entry['date']),
      category: str(entry['category']),
      subcategory: str(entry['subcategory']),
      type: str(entry['type']),
      // The description is a template key such as
      // `accounts-with-accounts-type-small`, and rendering it into English
      // needs a template file Companies House ships separately. Emitting the
      // key plus its values is honest; a partial local template map would
      // render some filings wrongly and nobody would notice which.
      description: str(entry['description']),
      description_values: Object.keys(values).length === 0 ? undefined : values,
      pages: num(entry['pages']),
      has_document: path(entry, 'links', 'document_metadata') !== undefined
    };
  });

  return { company_number: companyNumber, filings, pagination: pagination(payload, filings.length) };
}

export function projectCharges(payload: unknown, companyNumber: string): Body<GetChargesResult> {
  const source = obj(payload);
  const charges = arr(source['items']).map((item) => {
    const entry = obj(item);
    const particulars = obj(entry['particulars']);
    return {
      charge_code: str(entry['charge_code']),
      charge_number: num(entry['charge_number']),
      status: str(entry['status']),
      created_on: str(entry['created_on']),
      delivered_on: str(entry['delivered_on']),
      satisfied_on: str(entry['satisfied_on']),
      classification: str(path(entry, 'classification', 'description')),
      description: str(particulars['description']),
      persons_entitled: personsEntitled(entry['persons_entitled']),
      contains_floating_charge: bool(particulars['contains_floating_charge']),
      floating_charge_covers_all: bool(particulars['floating_charge_covers_all'])
    };
  });

  const total = num(source['total_count']) ?? charges.length;
  const satisfied = num(source['satisfied_count']) ?? 0;
  const partSatisfied = num(source['part_satisfied_count']) ?? 0;

  return {
    company_number: companyNumber,
    total_count: total,
    // The API reports what is settled but never what is not, which is the
    // number a person screening a supplier actually wants.
    outstanding_count: Math.max(total - satisfied - partSatisfied, 0),
    satisfied_count: satisfied,
    part_satisfied_count: partSatisfied,
    charges
  };
}

export function projectPsc(payload: unknown, companyNumber: string): Body<GetPscResult> {
  const source = obj(payload);
  const controllers = arr(source['items'])
    .map((item) => {
      const entry = obj(item);
      // Where a company cannot identify a PSC it files a statement instead of
      // a person, and the record has no name field at all.
      const name = str(entry['name']) ?? str(entry['statement']);
      if (name === undefined) return undefined;
      const ceasedOn = str(entry['ceased_on']);
      return {
        name,
        kind: str(entry['kind']),
        natures_of_control: arr(entry['natures_of_control'])
          .map((nature) => str(nature))
          .filter((nature): nature is string => nature !== undefined),
        notified_on: str(entry['notified_on']),
        ceased_on: ceasedOn,
        is_active: isActive(ceasedOn),
        nationality: str(entry['nationality']),
        country_of_residence: str(entry['country_of_residence']),
        date_of_birth: formatPartialDateOfBirth(entry['date_of_birth'])
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  return {
    company_number: companyNumber,
    active_count: num(source['active_count']),
    ceased_count: num(source['ceased_count']),
    controllers,
    pagination: pagination(payload, controllers.length)
  };
}

export function projectInsolvency(payload: unknown, companyNumber: string): Body<GetInsolvencyResult> {
  const cases = arr(obj(payload)['cases']).map((item) => {
    const entry = obj(item);
    return {
      type: str(entry['type']),
      number: str(entry['number']),
      dates: arr(entry['dates'])
        .map((dateEntry) => {
          const record = obj(dateEntry);
          const type = str(record['type']);
          const date = str(record['date']);
          return type === undefined || date === undefined ? undefined : { type, date };
        })
        .filter((value): value is { type: string; date: string } => value !== undefined),
      practitioners: arr(entry['practitioners'])
        .map((practitioner) => {
          const record = obj(practitioner);
          const name = str(record['name']);
          if (name === undefined) return undefined;
          return {
            name,
            role: str(record['role']),
            appointed_on: str(record['appointed_on']),
            ceased_to_act_on: str(record['ceased_to_act_on'])
          };
        })
        .filter((value): value is NonNullable<typeof value> => value !== undefined),
      notes: arr(entry['notes'])
        .map((note) => str(note))
        .filter((note): note is string => note !== undefined)
    };
  });

  return { company_number: companyNumber, case_count: cases.length, cases };
}

export function projectOfficerAppointments(
  payload: unknown,
  officerId: string
): Body<GetOfficerAppointmentsResult> {
  const source = obj(payload);
  const appointments = arr(source['items'])
    .map((item) => {
      const entry = obj(item);
      const companyNumber =
        str(path(entry, 'appointed_to', 'company_number')) ?? str(entry['company_number']);
      if (companyNumber === undefined) return undefined;
      const resignedOn = str(entry['resigned_on']);
      return {
        company_number: companyNumber,
        company_name: str(path(entry, 'appointed_to', 'company_name')) ?? str(entry['company_name']),
        company_status:
          str(path(entry, 'appointed_to', 'company_status')) ?? str(entry['company_status']),
        role: str(entry['officer_role']),
        appointed_on: str(entry['appointed_on']),
        resigned_on: resignedOn,
        is_active: isActive(resignedOn)
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  return {
    officer_id: officerId,
    name: str(source['name']),
    date_of_birth: formatPartialDateOfBirth(source['date_of_birth']),
    active_appointment_count: appointments.filter((appointment) => appointment.is_active).length,
    appointments,
    pagination: pagination(payload, appointments.length)
  };
}
