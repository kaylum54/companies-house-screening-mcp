import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from '../concurrency.js';
import { projectCompanyProfile } from '../domain/projections.js';
import { metaSchema } from '../domain/schemas.js';
import { CompaniesHouseError } from '../errors.js';
import type { RequestMeta } from '../http/client.js';
import { buildMeta, guard, mergeMeta, ok, resolveCompanyNumber } from './shared.js';
import type { ToolContext } from './shared.js';

export const DEADLINE_TOOL_NAMES = ['review_filing_deadlines'] as const;
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const dateInput = z.string().refine(validDate, 'Use a real calendar date in YYYY-MM-DD format.');
const deadlineSchema = z.object({
  due_date: z.string().optional(),
  category: z.enum(['overdue', 'due_soon', 'later', 'unknown']),
  days_until_due: z.number().int().optional(),
  register_overdue: z.boolean().optional().describe('Current register flag, independent of the chosen comparison date.'),
  reason: z.string().optional()
});
export function classifyDeadline(due: string | undefined, asOf: string, horizon: number, overdue?: boolean): z.infer<typeof deadlineSchema> {
  const base = overdue === undefined ? {} : { register_overdue: overdue };
  if (due === undefined || !validDate(due)) return { ...base, category: 'unknown', reason: 'The register did not supply a valid due date.' };
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86400000);
  return { ...base, due_date: due, days_until_due: days,
    category: days < 0 ? 'overdue' : days <= horizon ? 'due_soon' : 'later' };
}
const rowSchema = z.object({
  input_index: z.number().int(), client_reference: z.string().optional(), input_company_number: z.string(),
  company_number: z.string().optional(), name: z.string().optional(), registered_status: z.string().optional(),
  outcome: z.enum(['checked', 'not_screened']), reason: z.string().optional(),
  accounts: deadlineSchema.optional(), confirmation_statement: deadlineSchema.optional(),
  sections_included: z.array(z.literal('profile')), sections_unavailable: z.array(z.literal('profile')),
  meta: metaSchema.optional()
});
export const deadlinesOutput = z.object({
  as_of: z.string(), window_end: z.string(), horizon_days: z.number().int(), retrieved_at: z.string(),
  requested: z.number().int(), checked: z.number().int(), not_screened: z.number().int(),
  rows: z.array(rowSchema), meta: metaSchema,
  limitations: z.string()
});

export function registerDeadlineTools(server: McpServer, context: ToolContext): void {
  server.registerTool('review_filing_deadlines', {
    title: 'Review client filing deadlines',
    description: 'Use for accountant or bookkeeper client lists and monthly filing-date reviews. Accepts up to 50 confirmed company numbers with optional client references. Retrieves only company profiles and returns accounts and confirmation-statement deadlines as overdue, due_soon (today through the inclusive horizon), later or unknown. Preserves every input including repeated companies and invalid numbers. An as_of date classifies the currently retrieved records; it does not retrieve historical register state. This tool does not submit filings, calculate penalties, send reminders or schedule recurring work.',
    inputSchema: {
      clients: z.array(z.object({ company_number: z.string().max(256), client_reference: z.string().max(128).optional() })).min(1).max(50),
      as_of: dateInput.optional().describe('Comparison date; defaults to today in UTC. Not a historical lookup.'),
      horizon_days: z.number().int().min(0).max(366).default(30).describe('Inclusive days ahead; today is due_soon, not overdue.'),
      refresh: z.boolean().default(false).describe('Bypass cached profiles for a fresh review; spends API budget.')
    },
    outputSchema: deadlinesOutput.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ clients, as_of, horizon_days, refresh }, extra) => guard(context, 'review_filing_deadlines', async () => {
    const now = context.now();
    const asOf = as_of ?? new Date(now).toISOString().slice(0, 10);
    const windowEnd = new Date(Date.parse(`${asOf}T00:00:00Z`) + horizon_days * 86400000).toISOString().slice(0, 10);
    const metas: RequestMeta[] = [];
    const unique = new Map<string, Omit<z.infer<typeof rowSchema>, 'input_index' | 'input_company_number' | 'client_reference'>>();
    const entries = clients.map((client, input_index) => {
      let number: string | undefined;
      try { number = resolveCompanyNumber(client.company_number); } catch { /* Preserve invalid rows below. */ }
      return { ...client, input_index, number };
    });
    const numbers = [...new Set(entries.flatMap(entry => entry.number === undefined ? [] : [entry.number]))];
    const cachedNumbers = new Set((await Promise.all(numbers.map(async number =>
      await context.client.hasFreshCache({ path: `/company/${number}`, resource: 'company-profile', bypassCache: refresh, signal: extra.signal }) ? number : undefined
    ))).filter((number): number is string => number !== undefined));
    extra.signal.throwIfAborted();
    const needsRequest = numbers.filter(number => !cachedNumbers.has(number));
    const budget = needsRequest.length > 0 ? await context.client.budget() : context.client.rateLimit;
    extra.signal.throwIfAborted();
    const affordable = budget.boundBy === 'unavailable' ? 0 : Math.max(0, Math.floor(budget.remaining));
    for (const number of needsRequest.slice(affordable)) unique.set(number, {
      company_number: number, outcome: 'not_screened', sections_included: [], sections_unavailable: ['profile'],
      reason: budget.boundBy === 'unavailable' ? 'The shared API budget service is unavailable.' : 'Insufficient API budget; retry after the current rate-limit window.'
    });
    await mapWithConcurrency([...numbers.filter(number => cachedNumbers.has(number)), ...needsRequest.slice(0, affordable)], DEFAULT_CONCURRENCY, async number => {
      extra.signal.throwIfAborted();
      try {
        const response = await context.client.get<unknown>({ path: `/company/${number}`, resource: 'company-profile',
          label: 'company', identifier: number, signal: extra.signal, bypassCache: refresh });
        extra.signal.throwIfAborted();
        const profile = projectCompanyProfile(response.data, number, now);
        metas.push(response.meta);
        unique.set(number, { company_number: number, name: profile.name, registered_status: profile.status,
          outcome: 'checked', sections_included: ['profile'], sections_unavailable: [], meta: buildMeta(response.meta),
          accounts: classifyDeadline(profile.accounts.next_due, asOf, horizon_days, profile.accounts.overdue),
          confirmation_statement: classifyDeadline(profile.confirmation_statement.next_due, asOf, horizon_days, profile.confirmation_statement.overdue) });
      } catch (error) {
        extra.signal.throwIfAborted();
        context.metrics?.subrequestFailed();
        unique.set(number, { company_number: number, outcome: 'not_screened', sections_included: [], sections_unavailable: ['profile'],
          reason: CompaniesHouseError.is(error) ? error.message : 'The company profile could not be read.' });
      }
    });
    const rows = entries.map(entry => ({
      ...(entry.number === undefined ? { outcome: 'not_screened' as const, reason: 'Supply a confirmed UK company number; names and invalid numbers are not resolved by this tool.', sections_included: [] as 'profile'[], sections_unavailable: ['profile'] as 'profile'[] } : unique.get(entry.number)!),
      input_index: entry.input_index, input_company_number: entry.company_number,
      ...(entry.client_reference === undefined ? {} : { client_reference: entry.client_reference })
    }));
    const checked = rows.filter(row => row.outcome === 'checked').length;
    return ok({ as_of: asOf, window_end: windowEnd, horizon_days, retrieved_at: new Date(now).toISOString(),
      requested: clients.length, checked, not_screened: clients.length - checked, rows,
      meta: mergeMeta(metas, context.client.rateLimit),
      limitations: 'Current register records classified against as_of, not historical data. Check registered status and data freshness before follow-up. No filings, penalties, reminders or recurring schedule are created.' });
  }));
}
