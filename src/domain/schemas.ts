import { z } from 'zod';

import { SIGNAL_CODES } from './signals.js';

/**
 * Output schemas.
 *
 * These are the contract. Upstream payloads are read loosely (see `read.ts`);
 * what this server emits is validated strictly, because that is the half we
 * control and the half consumers depend on.
 *
 * Every `.describe()` here does double duty: it reaches the model as part of
 * the tool's output schema, and in phase 4 it becomes the generated reference
 * page for the tool. Documentation drift is impossible when the schema is the
 * only source.
 */

export const metaSchema = z
  .object({
    cached: z.boolean().describe('Answer came from the local cache rather than a live request.'),
    stale: z
      .boolean()
      .describe(
        'Answer came from an expired cache entry because Companies House was unreachable. Treat the data as possibly out of date.'
      ),
    age_seconds: z
      .number()
      .optional()
      .describe('How long ago the cached answer was retrieved. Absent for a live answer.'),
    rate_limit_remaining: z
      .number()
      .describe('Requests still available in the current five-minute window. Pace long runs by this.'),
    rate_limit_resets_in_ms: z.number().describe('Milliseconds until more budget becomes available.'),
    licence: z.literal('OGL-v3.0').describe('OGL v3.0 applies to eligible public-sector information. Personal data and other OGL exclusions are not licensed by this label; applicable data-protection duties still apply.')
  })
  .describe('Provenance and budget for this answer.');

export const paginationSchema = z
  .object({
    start_index: z.number(),
    items_per_page: z.number(),
    total_results: z.number(),
    returned: z.number().describe('How many records are in this response.'),
    has_more: z
      .boolean()
      .describe('More records exist. Call again with start_index advanced by `returned`.')
  })
  .describe('Where this page sits in the full result set.');

const rawSchema = z
  .unknown()
  .optional()
  .describe('The untouched Companies House payload. Present only when verbose was true.');

// --- shared record shapes -------------------------------------------------

export const companySummarySchema = z.object({
  company_number: z.string().describe('Use this for every other tool in this server.'),
  name: z.string(),
  status: z.string().optional().describe('active, dissolved, liquidation, administration, and so on.'),
  type: z.string().optional().describe('Raw Companies House type slug, e.g. ltd.'),
  type_description: z.string().optional().describe('The type in plain words.'),
  incorporated_on: z.string().optional(),
  dissolved_on: z.string().optional(),
  address: z.string().optional().describe('Registered office, on one line.')
});

export const officerSummarySchema = z.object({
  officer_id: z
    .string()
    .optional()
    .describe('Pass to get_officer_appointments to see every other company this person runs.'),
  name: z.string(),
  role: z.string().optional().describe('director, secretary, llp-member, and so on.'),
  appointed_on: z.string().optional(),
  resigned_on: z.string().optional(),
  is_active: z.boolean(),
  nationality: z.string().optional(),
  country_of_residence: z.string().optional(),
  occupation: z.string().optional(),
  date_of_birth: z
    .string()
    .optional()
    .describe('Month and year only, as YYYY-MM. Companies House does not publish the day.'),
  address: z
    .string()
    .optional()
    .describe('Service address. Only present when verbose was true; it is personal data.')
});

// --- tool outputs ---------------------------------------------------------

export const findCompanyOutput = z.object({
  query: z.string(),
  companies: z.array(companySummarySchema),
  exact_name_match: z
    .string()
    .optional()
    .describe('Company number whose name matches the query exactly. Absent if none did.'),
  disambiguation_needed: z
    .boolean()
    .describe('More than one candidate and no exact name match. Ask the user which one they meant.'),
  pagination: paginationSchema,
  meta: metaSchema,
  raw: rawSchema
});

export const findOfficerOutput = z.object({
  query: z.string(),
  officers: z.array(
    z.object({
      officer_id: z.string().optional(),
      name: z.string(),
      appointment_count: z.number().optional(),
      date_of_birth: z.string().optional(),
      address: z.string().optional()
    })
  ),
  pagination: paginationSchema,
  meta: metaSchema,
  raw: rawSchema
});

export const getCompanyOutput = z.object({
  company_number: z.string(),
  name: z.string(),
  status: z.string().optional(),
  status_detail: z.string().optional(),
  type: z.string().optional(),
  type_description: z.string().optional(),
  jurisdiction: z.string().optional(),
  incorporated_on: z.string().optional(),
  dissolved_on: z.string().optional(),
  age_years: z.number().optional().describe('Whole years since incorporation.'),
  registered_office_address: z.string().optional(),
  registered_office_in_dispute: z.boolean().optional(),
  sic_codes: z.array(z.string()).describe('Standard Industrial Classification codes for the trade.'),
  accounts: z.object({
    next_due: z.string().optional(),
    next_made_up_to: z.string().optional(),
    last_made_up_to: z.string().optional(),
    overdue: z.boolean().optional()
  }),
  confirmation_statement: z.object({
    next_due: z.string().optional(),
    next_made_up_to: z.string().optional(),
    last_made_up_to: z.string().optional(),
    overdue: z.boolean().optional()
  }),
  flags: z
    .object({
      is_active: z.boolean(),
      accounts_overdue: z.boolean(),
      confirmation_statement_overdue: z.boolean(),
      has_charges: z.boolean(),
      has_insolvency_history: z.boolean(),
      has_been_liquidated: z.boolean(),
      incorporated_within_last_year: z.boolean(),
      can_file: z.boolean().optional()
    })
    .describe('Derived risk signals. Each one is computed here, not returned by Companies House.'),
  meta: metaSchema,
  raw: rawSchema
});

export const getOfficersOutput = z.object({
  company_number: z.string(),
  active_count: z.number().optional(),
  resigned_count: z.number().optional(),
  inactive_count: z
    .number()
    .optional()
    .describe(
      'Appointments that ended because the company did, rather than by resignation. Non-zero on a dissolved company, and the reason active + resigned can fall short of the total.'
    ),
  officers: z.array(officerSummarySchema),
  pagination: paginationSchema,
  meta: metaSchema,
  raw: rawSchema
});

export const getFilingHistoryOutput = z.object({
  company_number: z.string(),
  filings: z.array(
    z.object({
      date: z.string().optional(),
      category: z.string().optional().describe('accounts, confirmation-statement, officers, mortgage, …'),
      subcategory: z.string().optional(),
      type: z.string().optional().describe('The form code, e.g. AA, CS01, MR01.'),
      description: z
        .string()
        .optional()
        .describe('Companies House description key, e.g. accounts-with-accounts-type-small.'),
      description_values: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Values that fill the placeholders in the description key.'),
      pages: z.number().optional(),
      has_document: z.boolean().describe('A filed document exists and could be fetched.')
    })
  ),
  pagination: paginationSchema,
  meta: metaSchema,
  raw: rawSchema
});

export const getChargesOutput = z.object({
  company_number: z.string(),
  total_count: z.number(),
  outstanding_count: z.number().describe('Derived: total minus satisfied and part-satisfied.'),
  satisfied_count: z.number(),
  part_satisfied_count: z.number(),
  charges: z.array(
    z.object({
      charge_code: z.string().optional(),
      charge_number: z.number().optional(),
      status: z.string().optional().describe('outstanding, fully-satisfied, part-satisfied.'),
      created_on: z.string().optional(),
      delivered_on: z.string().optional(),
      satisfied_on: z.string().optional(),
      classification: z.string().optional(),
      description: z.string().optional(),
      persons_entitled: z.array(z.string()).describe('Who holds the charge — usually a lender.'),
      contains_floating_charge: z.boolean().optional(),
      floating_charge_covers_all: z.boolean().optional()
    })
  ),
  meta: metaSchema,
  raw: rawSchema
});

export const getPscOutput = z.object({
  company_number: z.string(),
  active_count: z.number().optional(),
  ceased_count: z.number().optional(),
  controllers: z.array(
    z.object({
      name: z.string(),
      kind: z.string().optional().describe('Individual, corporate entity, legal person, or a statement.'),
      natures_of_control: z
        .array(z.string())
        .describe('How control is held, e.g. ownership-of-shares-75-to-100-percent.'),
      notified_on: z.string().optional(),
      ceased_on: z.string().optional(),
      is_active: z.boolean(),
      nationality: z.string().optional(),
      country_of_residence: z.string().optional(),
      date_of_birth: z.string().optional().describe('Month and year only, as YYYY-MM.')
    })
  ),
  pagination: paginationSchema,
  meta: metaSchema,
  raw: rawSchema
});

export const getInsolvencyOutput = z.object({
  company_number: z.string(),
  case_count: z.number(),
  cases: z.array(
    z.object({
      type: z.string().optional().describe('creditors-voluntary-liquidation, administration, and so on.'),
      number: z.string().optional(),
      dates: z.array(z.object({ type: z.string(), date: z.string() })),
      practitioners: z.array(
        z.object({
          name: z.string(),
          role: z.string().optional(),
          appointed_on: z.string().optional(),
          ceased_to_act_on: z.string().optional()
        })
      ),
      notes: z.array(z.string())
    })
  ),
  meta: metaSchema,
  raw: rawSchema
});

export const getOfficerAppointmentsOutput = z.object({
  officer_id: z.string(),
  name: z.string().optional(),
  date_of_birth: z.string().optional(),
  active_appointment_count: z.number().describe('Derived from the returned page, not the whole set.'),
  appointments: z.array(
    z.object({
      company_number: z.string(),
      company_name: z.string().optional(),
      company_status: z.string().optional(),
      role: z.string().optional(),
      appointed_on: z.string().optional(),
      resigned_on: z.string().optional(),
      is_active: z.boolean()
    })
  ),
  pagination: paginationSchema,
  meta: metaSchema,
  raw: rawSchema
});

export type Meta = z.infer<typeof metaSchema>;
export type FindCompanyResult = z.infer<typeof findCompanyOutput>;
export type FindOfficerResult = z.infer<typeof findOfficerOutput>;
export type GetCompanyResult = z.infer<typeof getCompanyOutput>;
export type GetOfficersResult = z.infer<typeof getOfficersOutput>;
export type GetFilingHistoryResult = z.infer<typeof getFilingHistoryOutput>;
export type GetChargesResult = z.infer<typeof getChargesOutput>;
export type GetPscResult = z.infer<typeof getPscOutput>;
export type GetInsolvencyResult = z.infer<typeof getInsolvencyOutput>;
export type GetOfficerAppointmentsResult = z.infer<typeof getOfficerAppointmentsOutput>;

// --- composite tools (phase 3) -------------------------------------------

export const signalSchema = z
  .object({
    code: z.enum(SIGNAL_CODES).describe('Stable identifier for the observation.'),
    detail: z.string().describe('The observation in one sentence, with the dates or names behind it.')
  })
  .describe(
    'A fact read off the register. Not a rating: nothing here weights or combines signals, and an empty list means nothing on the list was found, not that the company is sound.'
  );

export const sectionUnavailableSchema = z.object({
  section: z.string().describe('Which part of the snapshot could not be read.'),
  code: z.string().describe('The error code from the failed request.'),
  message: z.string()
});

export const companySnapshotOutput = z.object({
  company_number: z.string(),
  name: z.string(),
  status: z.string().optional(),
  type_description: z.string().optional(),
  incorporated_on: z.string().optional(),
  dissolved_on: z.string().optional(),
  age_years: z.number().optional(),
  registered_office_address: z.string().optional(),
  sic_codes: z.array(z.string()),
  accounts: z.object({ next_due: z.string().optional(), overdue: z.boolean().optional() }),
  confirmation_statement: z.object({
    next_due: z.string().optional(),
    overdue: z.boolean().optional()
  }),
  officers: z
    .object({
      active_count: z.number().optional(),
      resigned_count: z.number().optional(),
      pagination: paginationSchema.describe('Coverage of the fetched officer page, before filtering to active officers. Follow get_officers pagination for the full list; counts describe the whole register.'),
      active: z.array(
        z.object({
          name: z.string(),
          role: z.string().optional(),
          officer_id: z.string().optional(),
          appointed_on: z.string().optional()
        })
      )
    })
    .optional(),
  charges: z
    .object({
      total_count: z.number(),
      outstanding_count: z.number(),
      satisfied_count: z.number(),
      part_satisfied_count: z.number(),
      holders: z.array(z.string()).describe('Holders of returned charges not recorded as fully satisfied.')
    })
    .optional(),
  insolvency: z
    .object({ case_count: z.number(), types: z.array(z.string()) })
    .optional(),
  signals: z.array(signalSchema),
  sections_included: z
    .array(z.string())
    .describe('Which sections were fetched. Signals can only reflect the sections listed here.'),
  sections_unavailable: z
    .array(sectionUnavailableSchema)
    .describe('Sections that failed. The snapshot is still returned; treat those signals as unknown.'),
  meta: metaSchema,
  raw: rawSchema
});

export const screenCompaniesOutput = z.object({
  requested: z.number(),
  sections_used: z
    .array(z.string())
    .describe('Signals in this table can only reflect these sections. Officers are off by default.'),
  screened: z.array(
    z.object({
      input: z.string().describe('What was passed in, so rows can be matched back to the source list.'),
      company_number: z.string(),
      name: z.string(),
      status: z.string().optional(),
      incorporated_on: z.string().optional(),
      age_years: z.number().optional(),
      signal_codes: z.array(z.enum(SIGNAL_CODES)),
      signal_count: z.number().describe('Call company_snapshot on the number for the detail behind these.'),
      sections_included: z.array(z.string()).describe('Sections actually fetched for this company.'),
      sections_unavailable: z.array(sectionUnavailableSchema),
      officers_pagination: paginationSchema.optional().describe('Officer page coverage when officers were requested.'),
      meta: metaSchema
    })
  ),
  unresolved: z
    .array(
      z.object({
        input: z.string(),
        reason: z.string(),
        candidates: z
          .array(companySummarySchema.pick({ company_number: true, name: true, status: true }))
          .optional()
          .describe('Ask which was meant, then screen the chosen number directly.')
      })
    )
    .describe('Inputs that could not be resolved to exactly one company. Never guessed at.'),
  not_screened: z
    .array(z.object({ input: z.string(), reason: z.string() }))
    .describe('Inputs deliberately skipped, with the reason. Nothing is dropped silently.'),
  meta: metaSchema
});

export type Signal = z.infer<typeof signalSchema>;
export type CompanySnapshotResult = z.infer<typeof companySnapshotOutput>;
export type ScreenCompaniesResult = z.infer<typeof screenCompaniesOutput>;
