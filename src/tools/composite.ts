import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { isValidCompanyNumber, normaliseCompanyNumber } from '../company-number.js';
import { attempt, DEFAULT_CONCURRENCY, mapWithConcurrency } from '../concurrency.js';
import type { Body } from '../domain/projections.js';
import {
  projectCharges,
  projectCompanyProfile,
  projectCompanySearch,
  projectInsolvency,
  projectOfficers
} from '../domain/projections.js';
import type {
  CompanySnapshotResult,
  GetChargesResult,
  GetCompanyResult,
  GetInsolvencyResult,
  GetOfficersResult,
  ScreenCompaniesResult
} from '../domain/schemas.js';
import { companySnapshotOutput, screenCompaniesOutput } from '../domain/schemas.js';
import type { SectionFailure, SnapshotSection } from '../domain/snapshot.js';
import { buildSnapshot } from '../domain/snapshot.js';
import { CompaniesHouseError } from '../errors.js';
import type { RequestMeta } from '../http/client.js';
import { CompaniesHouseClient } from '../http/client.js';
import { budgetUnavailable } from '../http/rate-limiter.js';
import type { MetricsRecorder } from '../telemetry/metrics.js';
import type { ToolContext } from './shared.js';
import { companyNumberInput, fail, guard, mergeMeta, ok, resolveCompanyNumber, verboseInput, withRaw, MAX_QUERY_LENGTH} from './shared.js';

/**
 * The composite tools.
 *
 * These are the reason this server exists rather than being twenty-two
 * endpoint wrappers. `company_snapshot` answers "tell me about this company"
 * in one call instead of four; `screen_companies` answers "here are thirty
 * suppliers, which ones should I look at" — the question somebody actually
 * has at nine in the morning with a spreadsheet open.
 */

/** Guards against somebody pasting an entire customer list into one call. */
const MAX_SCREEN_INPUTS = 50;

/** How many candidates to show when a name cannot be resolved to one company. */
const MAX_CANDIDATES = 5;

interface SectionResults {
  profile: Body<GetCompanyResult>;
  officers?: Body<GetOfficersResult> | undefined;
  charges?: Body<GetChargesResult> | undefined;
  insolvency?: Body<GetInsolvencyResult> | undefined;
  requested: SnapshotSection[];
  unavailable: SectionFailure[];
  metas: RequestMeta[];
}

/**
 * Fetches the sections a snapshot needs.
 *
 * The profile is fetched first and on its own, rather than in parallel with
 * everything else. Firing all four at once would shave a round trip off the
 * happy path and would spend four requests instead of one every time somebody
 * mistypes a company number. Against a budget of 600 per five minutes, and
 * with the rate limiter serialising acquisition anyway, the round trip is the
 * cheaper thing to give up.
 */
async function fetchSections(
  client: CompaniesHouseClient,
  companyNumber: string,
  sections: SnapshotSection[],
  now: number,
  metrics?: MetricsRecorder | undefined
): Promise<SectionResults> {
  const profileResponse = await client.get<unknown>({
    path: `/company/${companyNumber}`,
    resource: 'company-profile',
    label: 'company',
    identifier: companyNumber
  });

  const results: SectionResults = {
    profile: projectCompanyProfile(profileResponse.data, companyNumber, now),
    requested: sections,
    unavailable: [],
    metas: [profileResponse.meta]
  };

  const rest = sections.filter((section) => section !== 'profile');
  if (rest.length === 0) return results;

  const fetched = await mapWithConcurrency(rest, DEFAULT_CONCURRENCY, async (section) => {
    const outcome = await attempt(async () => {
      switch (section) {
        case 'officers':
          return await client.get<unknown>({
            path: `/company/${companyNumber}/officers`,
            resource: 'officers',
            label: 'officers for company',
            identifier: companyNumber
          });
        case 'charges':
          return await client.get<unknown>({
            path: `/company/${companyNumber}/charges`,
            resource: 'charges',
            label: 'charges for company',
            identifier: companyNumber
          });
        case 'insolvency':
          return await client.get<unknown>({
            path: `/company/${companyNumber}/insolvency`,
            resource: 'insolvency',
            label: 'insolvency history for company',
            identifier: companyNumber
          });
        default:
          throw new Error(`unhandled section ${section}`);
      }
    });
    return { section, outcome };
  });

  for (const { section, outcome } of fetched) {
    if (outcome.ok) {
      results.metas.push(outcome.value.meta);
      if (section === 'officers') results.officers = projectOfficers(outcome.value.data, companyNumber, false);
      if (section === 'charges') results.charges = projectCharges(outcome.value.data, companyNumber);
      if (section === 'insolvency') results.insolvency = projectInsolvency(outcome.value.data, companyNumber);
      continue;
    }

    const error = outcome.error;
    // A 404 on charges or insolvency does not mean the request failed. It is
    // how Companies House says "this company has none", and recording it as
    // an outage would put a scary "unavailable" note on every clean company.
    if (
      CompaniesHouseError.is(error) &&
      error.code === 'RESOURCE_NOT_FOUND' &&
      (section === 'charges' || section === 'insolvency')
    ) {
      if (section === 'charges') {
        results.charges = {
          company_number: companyNumber,
          total_count: 0,
          outstanding_count: 0,
          satisfied_count: 0,
          part_satisfied_count: 0,
          charges: []
        };
      } else {
        results.insolvency = { company_number: companyNumber, case_count: 0, cases: [] };
      }
      continue;
    }

    // Absorbed into the answer rather than failing the whole snapshot, which
    // is right for the caller and invisible to everybody else. Counted so that
    // an upstream wobble degrading every answer on the server does not produce
    // a dataset of clean `ok` rows.
    metrics?.subrequestFailed();
    results.unavailable.push({
      section,
      code: CompaniesHouseError.is(error) ? error.code : 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error)
    });
  }

  return results;
}

type Resolution =
  | { kind: 'resolved'; input: string; companyNumber: string }
  | {
      kind: 'unresolved';
      input: string;
      reason: string;
      candidates?: { company_number: string; name: string; status?: string | undefined }[];
    };

/**
 * Turns one screening input into a company number, or explains why it could
 * not.
 *
 * The rule from ADR 5 applies with more force in a batch than it does in a
 * single call: thirty rows are read as a table and nobody re-checks row
 * nineteen. So a name that matches several companies becomes an unresolved
 * row with its candidates attached, never a best guess.
 */
async function resolveInput(
  client: CompaniesHouseClient,
  input: string,
  metrics?: MetricsRecorder
): Promise<Resolution> {
  const trimmed = input.trim();
  if (trimmed === '') return { kind: 'unresolved', input, reason: 'The entry is empty.' };

  if (isValidCompanyNumber(trimmed)) {
    return { kind: 'resolved', input, companyNumber: normaliseCompanyNumber(trimmed).value };
  }

  const outcome = await attempt(async () =>
    client.get<unknown>({
      path: '/search/companies',
      query: { q: trimmed, items_per_page: MAX_CANDIDATES },
      resource: 'search',
      label: 'company search'
    })
  );

  if (!outcome.ok) {
    // The same absorption `fetchSections` performs, and for a while the only
    // one that went uncounted: a name search that fails becomes an unresolved
    // row, so an upstream outage during the resolution half of a batch
    // returned an empty table under a clean `ok` — which is precisely the
    // silent degradation this column exists to reveal.
    metrics?.subrequestFailed();
    return {
      kind: 'unresolved',
      input,
      reason: CompaniesHouseError.is(outcome.error)
        ? `Search failed: ${outcome.error.message}`
        : 'Search failed.'
    };
  }

  const search = projectCompanySearch(outcome.value.data, trimmed);

  if (search.companies.length === 0) {
    return { kind: 'unresolved', input, reason: 'No company on the register matches this name.' };
  }

  if (search.exact_name_match !== undefined) {
    return { kind: 'resolved', input, companyNumber: search.exact_name_match };
  }

  if (search.companies.length === 1) {
    return { kind: 'resolved', input, companyNumber: search.companies[0]!.company_number };
  }

  return {
    kind: 'unresolved',
    input,
    reason: `${search.companies.length} companies match this name and none matches it exactly. Ask which was meant rather than assuming.`,
    candidates: search.companies.slice(0, MAX_CANDIDATES).map((company) => ({
      company_number: company.company_number,
      name: company.name,
      status: company.status
    }))
  };
}

export function registerCompositeTools(server: McpServer, context: ToolContext): void {
  const { client, logger } = context;

  const READ_ONLY = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  } as const;

  server.registerTool(
    'company_snapshot',
    {
      title: 'Company snapshot',
      description:
        'Everything worth knowing about one company in a single call: profile, serving officers, outstanding charges and insolvency cases, plus a list of signals read off the register. Use this instead of calling get_company, get_officers, get_charges and get_insolvency separately — it costs one round trip of yours rather than four, and it fills in the sections that Companies House reports as 404 when a company simply has none. The signals are facts, not a rating: this server does not score companies, and an empty signal list means nothing on the list was found rather than that the company is sound. Check sections_included before drawing a conclusion from an absent signal.',
      inputSchema: {
        company_number: companyNumberInput,
        include_officers: z
          .boolean()
          .optional()
          .describe('Include serving officers. On by default; turn it off to save one request per company.'),
        include_charges: z.boolean().optional().describe('Include charges. On by default.'),
        include_insolvency: z.boolean().optional().describe('Include insolvency cases. On by default.'),
        verbose: verboseInput
      },
      outputSchema: companySnapshotOutput.shape,
      annotations: READ_ONLY
    },
    async ({ company_number, include_officers, include_charges, include_insolvency, verbose }) =>
      guard(context, 'company_snapshot', async () => {
        const number = resolveCompanyNumber(company_number);
        const sections: SnapshotSection[] = ['profile'];
        if (include_officers !== false) sections.push('officers');
        if (include_charges !== false) sections.push('charges');
        if (include_insolvency !== false) sections.push('insolvency');

        const fetched = await fetchSections(client, number, sections, context.now(), context.metrics);
        const body: Body<CompanySnapshotResult> = buildSnapshot({
          profile: fetched.profile,
          officers: fetched.officers,
          charges: fetched.charges,
          insolvency: fetched.insolvency,
          requested: fetched.requested,
          unavailable: fetched.unavailable,
          now: context.now()
        });

        return ok(
          withRaw(
            { ...body, meta: mergeMeta(fetched.metas, client.rateLimit) },
            {
              profile: fetched.profile,
              officers: fetched.officers,
              charges: fetched.charges,
              insolvency: fetched.insolvency
            },
            verbose
          )
        );
      })
  );

  server.registerTool(
    'screen_companies',
    {
      title: 'Screen a list of companies',
      description:
        'Use this whenever the question is about MORE THAN ONE company — a list, a comparison, "which of these", a batch from procurement, anything with several names or numbers in it. Prefer it over calling company_snapshot repeatedly: it costs a quarter of the requests and returns a table you can read at a glance. Screens up to 50 companies and returns one row each: status, age, and which signals were found. Names that match more than one company are never guessed at; they come back under `unresolved` with their candidates so you can ask which was meant. Anything skipped for want of rate-limit budget comes back under `not_screened` with the reason, so the table is never quietly shorter than the list you passed in. Rows carry signal codes only — call company_snapshot on one company number for the detail behind them. Officers are excluded by default because they cost an extra request per company; sections_used says what the signals could see.',
      inputSchema: {
        companies: z
          .array(z.string().min(1).max(MAX_QUERY_LENGTH))
          .min(1)
          .max(MAX_SCREEN_INPUTS)
          .describe('Company names or numbers. Mixed input is fine. Maximum 50 per call.'),
        include_officers: z
          .boolean()
          .optional()
          .describe(
            'Fetch officers too, enabling the no_active_officers and recent_officer_departures signals. Off by default: it adds one request per company.'
          ),
        include_charges: z.boolean().optional().describe('Include charges. On by default.'),
        include_insolvency: z.boolean().optional().describe('Include insolvency cases. On by default.')
      },
      outputSchema: screenCompaniesOutput.shape,
      annotations: READ_ONLY
    },
    async ({ companies, include_officers, include_charges, include_insolvency }) =>
      guard(context, 'screen_companies', async () => {
        const sections: SnapshotSection[] = ['profile'];
        if (include_officers === true) sections.push('officers');
        if (include_charges !== false) sections.push('charges');
        if (include_insolvency !== false) sections.push('insolvency');

        // Deduplicate before spending anything. The same supplier appearing
        // twice in a pasted list is common and there is no reason to pay for
        // it twice.
        const seen = new Set<string>();
        const inputs = companies.filter((entry) => {
          const key = entry.trim().toLowerCase();
          if (key === '' || seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const resolutions = await mapWithConcurrency(inputs, DEFAULT_CONCURRENCY, (entry) =>
          resolveInput(client, entry, context.metrics)
        );

        const resolved = resolutions.filter(
          (resolution): resolution is Extract<Resolution, { kind: 'resolved' }> =>
            resolution.kind === 'resolved'
        );
        const unresolved = resolutions
          .filter(
            (resolution): resolution is Extract<Resolution, { kind: 'unresolved' }> =>
              resolution.kind === 'unresolved'
          )
          .map((resolution) => ({
            input: resolution.input,
            reason: resolution.reason,
            ...(resolution.candidates === undefined ? {} : { candidates: resolution.candidates })
          }));

        // Budget check before the expensive half. Screening what fits and
        // naming what did not is honest; running until the rate limiter
        // blocks and handing back a table that silently stops at row
        // nineteen is not.
        const perCompany = sections.length;
        // Asked of the budget itself rather than read off the last response.
        // On a shared deployment the cached figure can be a whole window out
        // of date, and sizing the batch against it would promise rows the
        // limiter then refuses — a table that stops early for a reason the
        // caller was never told, which is the failure ADR 8 exists to prevent.
        const budget = await client.budget();

        // `remaining: 0` has two meanings and only one of them is "wait".
        // Returning fifty rows that each blame an exhausted budget would be a
        // confident wrong diagnosis of an outage in this server, so say what
        // actually happened instead.
        if (budget.boundBy === 'unavailable') {
          // Recorded here because this path never reaches the limiter's own
          // refusal accounting: the batch is sized from a `peek`, so the
          // coordinator being down is discovered before anything is acquired.
          // Without this the row said `refusalCause: 'none'` and the one query
          // that groups refusals by cause dropped it silently.
          context.metrics?.refused('unavailable');
          return fail(budgetUnavailable(budget.resetInMs), logger, context.metrics);
        }

        const affordable = Math.max(Math.floor(budget.remaining / perCompany), 0);
        const toScreen = resolved.slice(0, affordable);
        // `resetInMs` is zero whenever *some* budget remains — the window is
        // not exhausted, there is simply not enough of it left for another
        // whole company. Fair sharing makes that the common case, and "retry
        // in 0 seconds" would be worse than saying nothing.
        const retry =
          budget.resetInMs > 0
            ? `Retry in ${Math.ceil(budget.resetInMs / 1000)} seconds, or pass a shorter list.`
            : 'Pass a shorter list, or retry once the current five-minute window rolls over.';
        const skipped = resolved.slice(affordable);
        // Counted here because nothing else will. The batch is sized from a
        // `peek`, so the limiter is never *asked* about the companies that are
        // dropped and its own refusal accounting never runs — which left the
        // headline case for this column, a batch that came back short and said
        // so, reading zero refusals.
        //
        // Counted in sub-requests, not companies: every other writer of this
        // column counts sub-requests, and one skipped company is `perCompany`
        // of them. Recording one per company summed two different units into
        // the same figure.
        //
        // The cause is derived rather than read off `boundBy`, because a
        // successful `peek` carries no `boundBy` at all — it is set only when
        // something was actually refused. Defaulting the absent case to
        // `client` therefore fired almost every time and sent an operator
        // looking at fair sharing while the window itself was the thing that
        // was nearly spent.
        const cause = budget.globalRemaining <= budget.remaining ? 'global' : 'client';
        const refusedSubrequests = skipped.length * perCompany;
        for (let i = 0; i < refusedSubrequests; i += 1) {
          context.metrics?.refused(budget.boundBy ?? cause);
        }
        const notScreened = skipped.map((resolution) => ({
          input: resolution.input,
          reason: `Not enough rate-limit budget left in this five-minute window. Screening this company needs ${perCompany} requests. ${retry}`
        }));

        if (notScreened.length > 0) {
          logger.warn('screen_companies truncated for rate-limit budget', {
            requested: inputs.length,
            screened: toScreen.length,
            skipped: notScreened.length
          });
        }

        const metas: RequestMeta[] = [];
        const rows = await mapWithConcurrency(toScreen, DEFAULT_CONCURRENCY, async (resolution) => {
          const outcome = await attempt(() =>
            fetchSections(client, resolution.companyNumber, sections, context.now(), context.metrics)
          );

          if (!outcome.ok) {
            // A whole company that could not be read, absorbed into the table.
            context.metrics?.subrequestFailed();
            return {
              failed: {
                input: resolution.input,
                reason: CompaniesHouseError.is(outcome.error)
                  ? outcome.error.message
                  : 'The company could not be read.'
              }
            };
          }

          metas.push(...outcome.value.metas);
          const snapshot = buildSnapshot({
            profile: outcome.value.profile,
            officers: outcome.value.officers,
            charges: outcome.value.charges,
            insolvency: outcome.value.insolvency,
            requested: outcome.value.requested,
            unavailable: outcome.value.unavailable,
            now: context.now()
          });

          return {
            row: {
              input: resolution.input,
              company_number: snapshot.company_number,
              name: snapshot.name,
              status: snapshot.status,
              incorporated_on: snapshot.incorporated_on,
              age_years: snapshot.age_years,
              signal_codes: snapshot.signals.map((signal) => signal.code),
              signal_count: snapshot.signals.length,
              sections_included: snapshot.sections_included,
              sections_unavailable: snapshot.sections_unavailable,
              officers_pagination: snapshot.officers?.pagination,
              meta: mergeMeta(outcome.value.metas, client.rateLimit)
            }
          };
        });

        const body: Body<ScreenCompaniesResult> = {
          requested: companies.length,
          sections_used: sections,
          screened: rows
            .map((result) => result.row)
            .filter((row): row is NonNullable<typeof row> => row !== undefined),
          unresolved,
          not_screened: [
            ...notScreened,
            ...rows
              .map((result) => result.failed)
              .filter((failed): failed is NonNullable<typeof failed> => failed !== undefined)
          ]
        };

        return ok({ ...body, meta: mergeMeta(metas, client.rateLimit) });
      })
  );
}

export const COMPOSITE_TOOL_NAMES = ['company_snapshot', 'screen_companies'] as const;
