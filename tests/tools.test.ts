import { afterEach, describe, expect, it } from 'vitest';

import { TOOL_NAMES } from '../src/tools/definitions.js';
import type { Harness } from './helpers/harness.js';
import { errorPayload, harnessAlways, harnessSequence, structured } from './helpers/harness.js';
import { loadFixture } from './helpers/support.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const PROFILE = loadFixture('company/profile-active.json');
const SEARCH = loadFixture('search/companies.json');
const OFFICERS = loadFixture('officers/officers-list.json');
const CHARGES = loadFixture('charges/charges-outstanding.json');
const PSC = loadFixture('psc/psc-list.json');
const INSOLVENCY = loadFixture('insolvency/insolvency-case.json');
const FILING_HISTORY = loadFixture('filing-history/filing-history.json');
const APPOINTMENTS = loadFixture('officers/appointments.json');
const OFFICER_SEARCH = loadFixture('search/officers.json');

describe('the tool surface', () => {
  it('registers every primitive tool it says it does', async () => {
    harness = await harnessAlways({ body: {} });
    const { tools } = await harness.client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([...TOOL_NAMES]));
  });

  it('declares every tool read-only', async () => {
    // There is no write path in this server. A host that respects annotations
    // should never prompt for approval on any of these.
    harness = await harnessAlways({ body: {} });
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} is not marked read-only`).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
  });

  it('gives every tool a description that says when to use it', async () => {
    harness = await harnessAlways({ body: {} });
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      // Tool descriptions are the only thing a model reads when choosing. A
      // one-line restatement of the name is the most common defect in
      // published MCP servers and it is invisible to every other test.
      expect((tool.description ?? '').length, `${tool.name} has a thin description`).toBeGreaterThan(180);
      expect(tool.title).toBeTruthy();
    }
  });

  it('publishes an output schema for every tool', async () => {
    harness = await harnessAlways({ body: {} });
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} has no output schema`).toBeDefined();
    }
  });

  it('tells the host how to use the server in its instructions', async () => {
    harness = await harnessAlways({ body: {} });
    const instructions = harness.client.getInstructions() ?? '';

    expect(instructions).toContain('find_company');
    expect(instructions).toContain('Open Government Licence');
  });
});

describe('find_company', () => {
  it('returns a shortlist and flags that disambiguation is needed', async () => {
    harness = await harnessAlways({ body: SEARCH });
    const result = structured(
      await harness.client.callTool({ name: 'find_company', arguments: { query: 'royal mail' } })
    );

    expect(result['disambiguation_needed']).toBe(true);
    expect(result['companies']).toHaveLength(5);
    expect(harness.calls[0]?.url).toContain('/search/companies');
    expect(harness.calls[0]?.url).toContain('q=royal+mail');
  });

  it('accepts a company number as a query too', async () => {
    harness = await harnessAlways({ body: SEARCH });
    const result = structured(
      await harness.client.callTool({ name: 'find_company', arguments: { query: '00000006' } })
    );
    expect(result['companies']).toBeDefined();
  });

  it('passes paging through to the API', async () => {
    harness = await harnessAlways({ body: SEARCH });
    await harness.client.callTool({
      name: 'find_company',
      arguments: { query: 'fixture', items_per_page: 5, start_index: 10 }
    });

    expect(harness.calls[0]?.url).toContain('items_per_page=5');
    expect(harness.calls[0]?.url).toContain('start_index=10');
  });
});

describe('get_company', () => {
  it('returns a shaped profile with derived flags', async () => {
    harness = await harnessAlways({ body: PROFILE });
    const result = structured(
      await harness.client.callTool({ name: 'get_company', arguments: { company_number: '04138203' } })
    );

    expect(result['name']).toBe('ROYAL MAIL GROUP LIMITED');
    expect(result['age_years']).toBe(25);
    expect(result['flags']).toMatchObject({ is_active: true, accounts_overdue: false });
    expect(result['meta']).toMatchObject({ cached: false, stale: false, licence: 'OGL-v3.0' });
  });

  it('zero-pads a short company number before calling the API', async () => {
    harness = await harnessAlways({ body: PROFILE });
    await harness.client.callTool({ name: 'get_company', arguments: { company_number: '6' } });

    expect(harness.calls[0]?.url).toContain('/company/00000006');
  });

  it('refuses a company name and names the tool to call instead', async () => {
    // The single most important behaviour in the server. Given a name a model
    // will invent a number, and a plausible wrong number returns a real
    // company that nothing downstream flags.
    harness = await harnessAlways({ body: PROFILE });
    const error = errorPayload(
      await harness.client.callTool({
        name: 'get_company',
        arguments: { company_number: 'Royal Mail Group Limited' }
      })
    );

    expect(error.code).toBe('INVALID_COMPANY_NUMBER');
    expect(error.message).toContain('looks like a company name');
    expect(error.next_step).toContain('find_company');
    expect(harness.calls).toHaveLength(0);
  });

  it('does not call the API at all when the number is malformed', async () => {
    harness = await harnessAlways({ body: PROFILE });
    const error = errorPayload(
      await harness.client.callTool({ name: 'get_company', arguments: { company_number: '123456789' } })
    );

    expect(error.code).toBe('INVALID_COMPANY_NUMBER');
    expect(harness.calls).toHaveLength(0);
  });

  it('attaches the raw payload only when verbose is set', async () => {
    harness = await harnessSequence([{ body: PROFILE }, { body: PROFILE }]);

    const quiet = structured(
      await harness.client.callTool({ name: 'get_company', arguments: { company_number: '04138203' } })
    );
    expect(quiet['raw']).toBeUndefined();

    const loud = structured(
      await harness.client.callTool({
        name: 'get_company',
        arguments: { company_number: '04138203', verbose: true }
      })
    );
    expect(loud['raw']).toEqual(PROFILE);
  });

  it('turns a 404 into an actionable error rather than a stack trace', async () => {
    harness = await harnessAlways({ status: 404 });
    const error = errorPayload(
      await harness.client.callTool({ name: 'get_company', arguments: { company_number: '99999999' } })
    );

    expect(error.code).toBe('RESOURCE_NOT_FOUND');
    expect(error.message).toContain('99999999');
    expect(error.next_step).toContain('find_company');
    expect(error.retryable).toBe(false);
  });

  it('reports a bad API key as configuration rather than a transient fault', async () => {
    harness = await harnessAlways({ status: 401 });
    const error = errorPayload(
      await harness.client.callTool({ name: 'get_company', arguments: { company_number: '04138203' } })
    );

    expect(error.code).toBe('AUTH_INVALID');
    expect(error.next_step).toContain('retrying will not fix it');
  });

  it('surfaces the remaining rate-limit budget so a long run can pace itself', async () => {
    harness = await harnessAlways({ body: PROFILE });
    const result = structured(
      await harness.client.callTool({ name: 'get_company', arguments: { company_number: '04138203' } })
    );

    const meta = result['meta'] as Record<string, unknown>;
    expect(meta['rate_limit_remaining']).toBe(569);
  });
});

describe('the remaining retrieval tools', () => {
  it('get_officers hides service addresses by default and exposes officer ids', async () => {
    harness = await harnessAlways({ body: OFFICERS });
    const result = structured(
      await harness.client.callTool({ name: 'get_officers', arguments: { company_number: '04138203' } })
    );

    const officers = result['officers'] as Record<string, unknown>[];
    expect(officers[0]?.['officer_id']).toBe('vKBmO0VKB84EFn2fjjCSWgLFHbY');
    expect(officers[0]?.['address']).toBeUndefined();
  });

  it('get_charges derives the outstanding count', async () => {
    harness = await harnessAlways({ body: CHARGES });
    const result = structured(
      await harness.client.callTool({ name: 'get_charges', arguments: { company_number: '04138203' } })
    );

    expect(result['outstanding_count']).toBe(2);
  });

  it('get_psc returns natures of control', async () => {
    harness = await harnessAlways({ body: PSC });
    const result = structured(
      await harness.client.callTool({ name: 'get_psc', arguments: { company_number: '04138203' } })
    );

    const controllers = result['controllers'] as Record<string, unknown>[];
    expect(controllers[0]?.['natures_of_control']).toContain('ownership-of-shares-75-to-100-percent');
  });

  it('get_insolvency returns the practitioners', async () => {
    harness = await harnessAlways({ body: INSOLVENCY });
    const result = structured(
      await harness.client.callTool({ name: 'get_insolvency', arguments: { company_number: '03782379' } })
    );

    expect(result['case_count']).toBe(1);
  });

  it('get_filing_history passes the category filter to the API', async () => {
    harness = await harnessAlways({ body: FILING_HISTORY });
    const result = structured(
      await harness.client.callTool({
        name: 'get_filing_history',
        arguments: { company_number: '00000006', category: 'accounts' }
      })
    );

    expect(harness.calls[0]?.url).toContain('category=accounts');
    expect((result['filings'] as unknown[]).length).toBe(5);
  });

  it('get_officer_appointments counts active appointments', async () => {
    harness = await harnessAlways({ body: APPOINTMENTS });
    const result = structured(
      await harness.client.callTool({
        name: 'get_officer_appointments',
        arguments: { officer_id: 'gBfDMtBVo3nHfig_wVfjaOA9o1M' }
      })
    );

    expect(result['active_appointment_count']).toBe(8);
    expect(harness.calls[0]?.url).toContain('/officers/gBfDMtBVo3nHfig_wVfjaOA9o1M/appointments');
  });

  it('get_officer_appointments escapes the officer id into the path', async () => {
    harness = await harnessAlways({ body: APPOINTMENTS });
    await harness.client.callTool({
      name: 'get_officer_appointments',
      arguments: { officer_id: 'a/b?c' }
    });

    expect(harness.calls[0]?.url).toContain('a%2Fb%3Fc');
  });

  it('find_officer returns candidate ids for a name', async () => {
    harness = await harnessAlways({ body: OFFICER_SEARCH });
    const result = structured(
      await harness.client.callTool({ name: 'find_officer', arguments: { query: 'smith' } })
    );

    const officers = result['officers'] as Record<string, unknown>[];
    expect(officers[0]?.['officer_id']).toBe('XR-3FAMZFTo1jT9bydQh4WWKKvI');
    expect(officers[0]?.['appointment_count']).toBe(1);
  });
});

describe('input validation', () => {
  it('rejects an empty query rather than searching for nothing', async () => {
    harness = await harnessAlways({ body: SEARCH });
    const result = await harness.client.callTool({ name: 'find_company', arguments: { query: '' } });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it('rejects a page size above the API maximum', async () => {
    harness = await harnessAlways({ body: SEARCH });
    const result = await harness.client.callTool({
      name: 'find_company',
      arguments: { query: 'fixture', items_per_page: 5000 }
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
});
