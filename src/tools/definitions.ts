import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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
} from '../domain/projections.js';
import {
  findCompanyOutput,
  findOfficerOutput,
  getChargesOutput,
  getCompanyOutput,
  getFilingHistoryOutput,
  getInsolvencyOutput,
  getOfficerAppointmentsOutput,
  getOfficersOutput,
  getPscOutput
} from '../domain/schemas.js';
import type { ToolContext } from './shared.js';
import {
  buildMeta,
  companyNumberInput,
  guard,
  itemsPerPageInput,
  ok,
  resolveCompanyNumber,
  startIndexInput,
  verboseInput,
  withRaw
} from './shared.js';

/**
 * The nine primitive tools.
 *
 * Descriptions are the highest-leverage text in this repository. They are the
 * only thing a model reads when deciding which tool to call, and a badly
 * worded one produces a failure that no unit test can see — the tool works
 * perfectly and never gets chosen, or gets chosen for the wrong question.
 * Phase 5 adds an eval that scores tool selection against natural-language
 * questions, which is how these get checked rather than assumed.
 *
 * Each description says what the tool returns, when to reach for it, and what
 * to call instead when it is the wrong one.
 */

// Read-only throughout. There is no write path in this server and there will
// not be one; filing to Companies House is a different API and a different
// risk profile. `idempotentHint` is meaningless while `readOnlyHint` is true
// but is set for hosts that check it independently.
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

export function registerTools(server: McpServer, context: ToolContext): void {
  const { client, logger } = context;

  server.registerTool(
    'find_company',
    {
      title: 'Find a company',
      description:
        'Search Companies House for a UK company by name, trading name or number. Start here whenever you have a name rather than a number, because every other tool in this server needs the number. Returns a shortlist with status, type and incorporation date so that companies with similar names can be told apart. When `disambiguation_needed` is true, ask the user which one they meant instead of taking the first result — dozens of live companies share a name, and picking the wrong one produces a confident answer about the wrong business.',
      inputSchema: {
        query: z.string().min(1).describe('Company name, partial name, or company number.'),
        items_per_page: itemsPerPageInput,
        start_index: startIndexInput,
        verbose: verboseInput
      },
      outputSchema: findCompanyOutput.shape,
      annotations: READ_ONLY
    },
    async ({ query, items_per_page, start_index, verbose }) =>
      guard(logger, async () => {
        const { data, meta } = await client.get<unknown>({
          path: '/search/companies',
          query: { q: query, items_per_page, start_index },
          resource: 'search',
          label: 'company search'
        });
        const body = projectCompanySearch(data, query);
        return ok(withRaw({ ...body, meta: buildMeta(meta) }, data, verbose));
      })
  );

  server.registerTool(
    'find_officer',
    {
      title: 'Find an officer',
      description:
        'Search Companies House for a company officer — a director, secretary or LLP member — by name. Returns candidate officer IDs with how many appointments each holds. Use it when you have a person and want the companies they are involved in; feed the officer_id to get_officer_appointments. Officer records are per-appointment-identity rather than per-person, so a common name returns many candidates and the appointment count and date of birth are usually what separates them.',
      inputSchema: {
        query: z.string().min(1).describe("The officer's name."),
        items_per_page: itemsPerPageInput,
        start_index: startIndexInput,
        verbose: verboseInput
      },
      outputSchema: findOfficerOutput.shape,
      annotations: READ_ONLY
    },
    async ({ query, items_per_page, start_index, verbose }) =>
      guard(logger, async () => {
        const { data, meta } = await client.get<unknown>({
          path: '/search/officers',
          query: { q: query, items_per_page, start_index },
          resource: 'search',
          label: 'officer search'
        });
        const body = projectOfficerSearch(data, query);
        return ok(withRaw({ ...body, meta: buildMeta(meta) }, data, verbose));
      })
  );

  server.registerTool(
    'get_company',
    {
      title: 'Get a company profile',
      description:
        'The registered profile for one UK company: legal name, status, type, incorporation date, registered office, SIC codes, and the accounts and confirmation statement due dates. Also returns derived flags that Companies House does not provide — whether filings are overdue, whether the company holds charges or has insolvency history, and whether it was incorporated within the last year. Use it to verify a company is real and active before relying on it. Needs a company number; call find_company first if you only have a name.',
      inputSchema: { company_number: companyNumberInput, verbose: verboseInput },
      outputSchema: getCompanyOutput.shape,
      annotations: READ_ONLY
    },
    async ({ company_number, verbose }) =>
      guard(logger, async () => {
        const number = resolveCompanyNumber(company_number);
        const { data, meta } = await client.get<unknown>({
          path: `/company/${number}`,
          resource: 'company-profile',
          label: 'company',
          identifier: number
        });
        const body = projectCompanyProfile(data, number, context.now());
        return ok(withRaw({ ...body, meta: buildMeta(meta) }, data, verbose));
      })
  );

  server.registerTool(
    'get_officers',
    {
      title: 'Get company officers',
      description:
        "The directors, secretaries and members of one company, current and resigned, each with an officer_id you can pass to get_officer_appointments. Use it to see who runs a company, or as the first step in a conflict-of-interest check across a board. Service addresses are withheld unless verbose is set, because they are personal data and are rarely what the question needs. Needs a company number; call find_company first if you only have a name.",
      inputSchema: {
        company_number: companyNumberInput,
        items_per_page: itemsPerPageInput,
        start_index: startIndexInput,
        verbose: verboseInput
      },
      outputSchema: getOfficersOutput.shape,
      annotations: READ_ONLY
    },
    async ({ company_number, items_per_page, start_index, verbose }) =>
      guard(logger, async () => {
        const number = resolveCompanyNumber(company_number);
        const { data, meta } = await client.get<unknown>({
          path: `/company/${number}/officers`,
          query: { items_per_page, start_index },
          resource: 'officers',
          label: 'officers for company',
          identifier: number
        });
        const body = projectOfficers(data, number, verbose === true);
        return ok(withRaw({ ...body, meta: buildMeta(meta) }, data, verbose));
      })
  );

  server.registerTool(
    'get_filing_history',
    {
      title: 'Get filing history',
      description:
        "What a company has filed and when — accounts, confirmation statements, officer changes, mortgages, address changes. Use it to judge whether a company is filing on time, to see when accounts were last made up, or to watch a competitor's filing cadence. Descriptions come back as Companies House template keys such as accounts-with-accounts-type-small, with their values alongside; the key is readable enough to interpret and is not translated here because a partial translation would render some filings wrongly. Filter with `category` to cut the volume. Needs a company number.",
      inputSchema: {
        company_number: companyNumberInput,
        category: z
          .string()
          .optional()
          .describe(
            'Restrict to one category, e.g. accounts, confirmation-statement, officers, mortgage, address, capital, incorporation, resolution, insolvency.'
          ),
        items_per_page: itemsPerPageInput,
        start_index: startIndexInput,
        verbose: verboseInput
      },
      outputSchema: getFilingHistoryOutput.shape,
      annotations: READ_ONLY
    },
    async ({ company_number, category, items_per_page, start_index, verbose }) =>
      guard(logger, async () => {
        const number = resolveCompanyNumber(company_number);
        const { data, meta } = await client.get<unknown>({
          path: `/company/${number}/filing-history`,
          query: { category, items_per_page, start_index },
          resource: 'filing-history',
          label: 'filing history for company',
          identifier: number
        });
        const body = projectFilingHistory(data, number);
        return ok(withRaw({ ...body, meta: buildMeta(meta) }, data, verbose));
      })
  );

  server.registerTool(
    'get_charges',
    {
      title: 'Get charges',
      description:
        'Secured debt registered against a company: who holds each charge, what it covers, when it was created and whether it has been satisfied. `outstanding_count` is derived here because Companies House reports what has been settled but never what has not, and outstanding charges are the number that matters when screening a supplier or a debtor. A floating charge covering all assets is worth reading closely. Needs a company number.',
      inputSchema: { company_number: companyNumberInput, verbose: verboseInput },
      outputSchema: getChargesOutput.shape,
      annotations: READ_ONLY
    },
    async ({ company_number, verbose }) =>
      guard(logger, async () => {
        const number = resolveCompanyNumber(company_number);
        const { data, meta } = await client.get<unknown>({
          path: `/company/${number}/charges`,
          resource: 'charges',
          label: 'charges for company',
          identifier: number
        });
        const body = projectCharges(data, number);
        return ok(withRaw({ ...body, meta: buildMeta(meta) }, data, verbose));
      })
  );

  server.registerTool(
    'get_psc',
    {
      title: 'Get persons with significant control',
      description:
        'Who actually controls a company, which is often not who its directors are. Returns each person or entity with significant control, how that control is held (shareholding band, voting rights, right to appoint directors), and whether the interest is current or ceased. Use it for beneficial-ownership and know-your-business checks. Where a company cannot identify a controller it files a statement instead of a person, and that statement is returned in the name field. Needs a company number.',
      inputSchema: {
        company_number: companyNumberInput,
        items_per_page: itemsPerPageInput,
        start_index: startIndexInput,
        verbose: verboseInput
      },
      outputSchema: getPscOutput.shape,
      annotations: READ_ONLY
    },
    async ({ company_number, items_per_page, start_index, verbose }) =>
      guard(logger, async () => {
        const number = resolveCompanyNumber(company_number);
        const { data, meta } = await client.get<unknown>({
          path: `/company/${number}/persons-with-significant-control`,
          query: { items_per_page, start_index },
          resource: 'psc',
          label: 'persons with significant control for company',
          identifier: number
        });
        const body = projectPsc(data, number);
        return ok(withRaw({ ...body, meta: buildMeta(meta) }, data, verbose));
      })
  );

  server.registerTool(
    'get_insolvency',
    {
      title: 'Get insolvency history',
      description:
        'Insolvency cases registered against a company: the type of proceeding, its key dates, and the insolvency practitioners appointed. Call it when get_company reports has_insolvency_history, or as part of a credit or supplier risk check. A company with no insolvency history returns a not-found error rather than an empty list, which is a quirk of the API and means exactly what it sounds like. Needs a company number.',
      inputSchema: { company_number: companyNumberInput, verbose: verboseInput },
      outputSchema: getInsolvencyOutput.shape,
      annotations: READ_ONLY
    },
    async ({ company_number, verbose }) =>
      guard(logger, async () => {
        const number = resolveCompanyNumber(company_number);
        const { data, meta } = await client.get<unknown>({
          path: `/company/${number}/insolvency`,
          resource: 'insolvency',
          label: 'insolvency history for company',
          identifier: number
        });
        const body = projectInsolvency(data, number);
        return ok(withRaw({ ...body, meta: buildMeta(meta) }, data, verbose));
      })
  );

  server.registerTool(
    'get_officer_appointments',
    {
      title: 'Get an officer’s appointments',
      description:
        'Every company an officer is or has been appointed to. This is the conflict-of-interest and director-network tool: run it across a board to find the shared directorship nobody declared, or across one person to see whether they have a history of dissolved companies. Needs an officer_id, which comes from get_officers or find_officer and never from a name.',
      inputSchema: {
        officer_id: z
          .string()
          .min(1)
          .describe('Officer identifier from get_officers or find_officer, not a person’s name.'),
        items_per_page: itemsPerPageInput,
        start_index: startIndexInput,
        verbose: verboseInput
      },
      outputSchema: getOfficerAppointmentsOutput.shape,
      annotations: READ_ONLY
    },
    async ({ officer_id, items_per_page, start_index, verbose }) =>
      guard(logger, async () => {
        const { data, meta } = await client.get<unknown>({
          path: `/officers/${encodeURIComponent(officer_id)}/appointments`,
          query: { items_per_page, start_index },
          resource: 'officer-appointments',
          label: 'appointments for officer',
          identifier: officer_id
        });
        const body = projectOfficerAppointments(data, officer_id);
        return ok(withRaw({ ...body, meta: buildMeta(meta) }, data, verbose));
      })
  );
}

/** Names of every tool this server exposes. Used by the docs generator and tests. */
export const TOOL_NAMES = [
  'find_company',
  'find_officer',
  'get_company',
  'get_officers',
  'get_filing_history',
  'get_charges',
  'get_psc',
  'get_insolvency',
  'get_officer_appointments'
] as const;
