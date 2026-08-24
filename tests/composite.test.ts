import { afterEach, describe, expect, it } from 'vitest';

import { COMPOSITE_TOOL_NAMES } from '../src/tools/composite.js';
import { TOOL_NAMES } from '../src/tools/definitions.js';
import type { Harness } from './helpers/harness.js';
import { errorPayload, harnessAlways, harnessRoutes, structured } from './helpers/harness.js';
import { loadFixture } from './helpers/support.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const PROFILE = loadFixture('company/profile-active.json');
const DISSOLVED = loadFixture('company/profile-dissolved.json');
const OFFICERS = loadFixture('officers/officers-list.json');
const CHARGES = loadFixture('charges/charges-outstanding.json');
const INSOLVENCY = loadFixture('insolvency/insolvency-case.json');
const SEARCH = loadFixture('search/companies.json');

/** The happy path for every section of a snapshot. */
const FULL_ROUTES: [RegExp, { body: unknown }][] = [
  [/\/officers/, { body: OFFICERS }],
  [/\/charges/, { body: CHARGES }],
  [/\/insolvency/, { body: INSOLVENCY }],
  [/\/search\/companies/, { body: SEARCH }],
  [/\/company\//, { body: PROFILE }]
];

describe('the composite tools are registered', () => {
  it('brings the surface to eleven tools', async () => {
    harness = await harnessAlways({ body: {} });
    const { tools } = await harness.client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...TOOL_NAMES, ...COMPOSITE_TOOL_NAMES].sort()
    );
  });

  it('tells the host to prefer them in the server instructions', async () => {
    harness = await harnessAlways({ body: {} });
    const instructions = harness.client.getInstructions() ?? '';

    expect(instructions).toContain('company_snapshot');
    expect(instructions).toContain('screen_companies');
    expect(instructions).toContain('not a rating');
  });
});

describe('company_snapshot', () => {
  it('answers four questions in one call', async () => {
    harness = await harnessRoutes(FULL_ROUTES);
    const result = structured(
      await harness.client.callTool({
        name: 'company_snapshot',
        arguments: { company_number: '04138203' }
      })
    );

    expect(result['name']).toBe('ROYAL MAIL GROUP LIMITED');
    expect(result['officers']).toBeDefined();
    expect(result['charges']).toMatchObject({ outstanding_count: 2 });
    expect(result['insolvency']).toMatchObject({ case_count: 1 });
    expect(harness.calls).toHaveLength(4);
  });

  it('fetches the profile before spending anything on the other sections', async () => {
    // A mistyped company number should cost one request, not four.
    harness = await harnessRoutes(FULL_ROUTES);
    await harness.client.callTool({
      name: 'company_snapshot',
      arguments: { company_number: '04138203' }
    });

    expect(harness.calls[0]?.url).toMatch(/\/company\/04138203$/);
  });

  it('spends only one request when the company does not exist', async () => {
    harness = await harnessRoutes([[/.*/, { status: 404 }]]);
    const error = errorPayload(
      await harness.client.callTool({
        name: 'company_snapshot',
        arguments: { company_number: '99999999' }
      })
    );

    expect(error.code).toBe('RESOURCE_NOT_FOUND');
    expect(harness.calls).toHaveLength(1);
  });

  it('lists only serving officers, because resigned ones are the long tail', async () => {
    harness = await harnessRoutes(FULL_ROUTES);
    const result = structured(
      await harness.client.callTool({
        name: 'company_snapshot',
        arguments: { company_number: '04138203' }
      })
    );

    // Five officers on the recorded page, none of them resigned, against 54
    // resigned across the whole register.
    const officers = result['officers'] as { active: unknown[]; resigned_count?: number };
    expect(officers.active).toHaveLength(5);
    expect(officers.resigned_count).toBe(54);
  });

  it('treats a 404 on charges as "none" rather than as a fault', async () => {
    // Companies House returns 404 for a company that simply has no charges.
    // Recording that as an outage would put a scary "unavailable" note on
    // every clean company on the register.
    harness = await harnessRoutes([
      [/\/charges/, { status: 404 }],
      [/\/insolvency/, { status: 404 }],
      [/\/officers/, { body: OFFICERS }],
      [/\/company\//, { body: PROFILE }]
    ]);
    const result = structured(
      await harness.client.callTool({
        name: 'company_snapshot',
        arguments: { company_number: '04138203' }
      })
    );

    expect(result['charges']).toMatchObject({ total_count: 0, outstanding_count: 0 });
    expect(result['insolvency']).toMatchObject({ case_count: 0 });
    expect(result['sections_unavailable']).toEqual([]);
    expect(result['sections_included']).toEqual(['profile', 'officers', 'charges', 'insolvency']);
  });

  it('still returns a snapshot when one section is genuinely broken', async () => {
    harness = await harnessRoutes([
      [/\/officers/, { status: 503 }],
      [/\/charges/, { body: CHARGES }],
      [/\/insolvency/, { body: INSOLVENCY }],
      [/\/company\//, { body: PROFILE }]
    ]);
    const result = structured(
      await harness.client.callTool({
        name: 'company_snapshot',
        arguments: { company_number: '04138203' }
      })
    );

    expect(result['name']).toBe('ROYAL MAIL GROUP LIMITED');
    expect(result['officers']).toBeUndefined();
    expect(result['sections_unavailable']).toEqual([
      { section: 'officers', code: 'UPSTREAM_UNAVAILABLE', message: expect.any(String) }
    ]);
    // The caller has to be able to tell "no signal found" from "never looked".
    expect(result['sections_included']).not.toContain('officers');
  });

  it('skips a section when asked to, and says it was not included', async () => {
    harness = await harnessRoutes(FULL_ROUTES);
    const result = structured(
      await harness.client.callTool({
        name: 'company_snapshot',
        arguments: { company_number: '04138203', include_officers: false }
      })
    );

    expect(harness.calls).toHaveLength(3);
    expect(result['sections_included']).toEqual(['profile', 'charges', 'insolvency']);
  });

  it('derives signals across the sections it read', async () => {
    harness = await harnessRoutes([
      [/\/officers/, { body: OFFICERS }],
      [/\/charges/, { body: CHARGES }],
      [/\/insolvency/, { body: INSOLVENCY }],
      [/\/company\//, { body: DISSOLVED }]
    ]);
    const result = structured(
      await harness.client.callTool({
        name: 'company_snapshot',
        arguments: { company_number: '00000006' }
      })
    );

    const signals = result['signals'] as { code: string; detail: string }[];
    const codes = signals.map((signal) => signal.code);
    expect(codes).toContain('dissolved');
    expect(codes).toContain('insolvency_history');
    expect(codes).toContain('outstanding_charges');
    // Ordered by materiality: the company being gone comes before its debts.
    expect(codes[0]).toBe('dissolved');
  });

  it('refuses a company name here too', async () => {
    harness = await harnessRoutes(FULL_ROUTES);
    const error = errorPayload(
      await harness.client.callTool({
        name: 'company_snapshot',
        arguments: { company_number: 'Royal Mail Group Limited' }
      })
    );

    expect(error.code).toBe('INVALID_COMPANY_NUMBER');
    expect(harness.calls).toHaveLength(0);
  });

  it('reports the merged budget across every request it made', async () => {
    harness = await harnessRoutes(FULL_ROUTES);
    const result = structured(
      await harness.client.callTool({
        name: 'company_snapshot',
        arguments: { company_number: '04138203' }
      })
    );

    // 570 effective budget, four requests spent.
    expect((result['meta'] as Record<string, unknown>)['rate_limit_remaining']).toBe(566);
  });
});

describe('screen_companies', () => {
  it('screens a list of company numbers without searching for them', async () => {
    harness = await harnessRoutes(FULL_ROUTES);
    const result = structured(
      await harness.client.callTool({
        name: 'screen_companies',
        arguments: { companies: ['04138203', '00000006'] }
      })
    );

    expect(result['requested']).toBe(2);
    expect(result['screened']).toHaveLength(2);
    expect(result['unresolved']).toEqual([]);
    expect(harness.calls.some((call) => call.url.includes('/search/'))).toBe(false);
  });

  it('resolves a name only when the match is unambiguous', async () => {
    // Routed by company number rather than answering every /company/ request
    // with the same profile: otherwise this test would pass while the tool
    // resolved to one company and reported another, which is the exact failure
    // the no-names rule exists to prevent.
    harness = await harnessRoutes([
      [
        /\/company\/14240638/,
        {
          body: {
            company_number: '14240638',
            company_name: 'ROYAL MAIL LIMITED',
            company_status: 'active',
            type: 'ltd',
            date_of_creation: '2022-07-18'
          }
        }
      ],
      ...FULL_ROUTES
    ]);
    const result = structured(
      await harness.client.callTool({
        name: 'screen_companies',
        arguments: { companies: ['Royal Mail Limited'] }
      })
    );

    const screened = result['screened'] as Record<string, unknown>[];
    expect(screened).toHaveLength(1);
    expect(screened[0]?.['company_number']).toBe('14240638');
    expect(screened[0]?.['input']).toBe('Royal Mail Limited');
  });

  it('never guesses which company an ambiguous name meant', async () => {
    // Thirty rows are read as a table and nobody re-checks row nineteen, so a
    // guess here is more dangerous than a guess in a single call.
    harness = await harnessRoutes(FULL_ROUTES);
    const result = structured(
      await harness.client.callTool({
        name: 'screen_companies',
        arguments: { companies: ['Royal Mail'] }
      })
    );

    expect(result['screened']).toEqual([]);
    const unresolved = result['unresolved'] as Record<string, unknown>[];
    expect(unresolved[0]?.['input']).toBe('Royal Mail');
    expect(unresolved[0]?.['reason']).toContain('none matches it exactly');
    expect(unresolved[0]?.['candidates']).toHaveLength(5);
  });

  it('says so when a name matches nothing', async () => {
    harness = await harnessRoutes([
      [/\/search\/companies/, { body: { items: [], total_results: 0 } }],
      [/\/company\//, { body: PROFILE }]
    ]);
    const result = structured(
      await harness.client.callTool({
        name: 'screen_companies',
        arguments: { companies: ['Nonexistent Trading Co'] }
      })
    );

    expect((result['unresolved'] as Record<string, unknown>[])[0]?.['reason']).toContain('No company');
  });

  it('does not pay twice for the same company listed twice', async () => {
    harness = await harnessRoutes(FULL_ROUTES);
    const result = structured(
      await harness.client.callTool({
        name: 'screen_companies',
        arguments: { companies: ['04138203', '04138203', ' 04138203 '] }
      })
    );

    expect(result['requested']).toBe(3);
    expect(result['screened']).toHaveLength(1);
  });

  it('returns signal codes per row and points at the snapshot for detail', async () => {
    harness = await harnessRoutes([
      [/\/charges/, { body: CHARGES }],
      [/\/insolvency/, { body: INSOLVENCY }],
      [/\/company\//, { body: DISSOLVED }]
    ]);
    const result = structured(
      await harness.client.callTool({
        name: 'screen_companies',
        arguments: { companies: ['04138203'] }
      })
    );

    const row = (result['screened'] as Record<string, unknown>[])[0];
    expect(row?.['signal_codes']).toContain('dissolved');
    expect(row?.['signal_count']).toBeGreaterThan(0);
    // Rows carry codes, not sentences — the table stays readable at 50 rows.
    expect(JSON.stringify(row)).not.toContain('was dissolved on');
  });

  it('excludes officers by default and says which sections the signals saw', async () => {
    harness = await harnessRoutes(FULL_ROUTES);
    const result = structured(
      await harness.client.callTool({
        name: 'screen_companies',
        arguments: { companies: ['04138203'] }
      })
    );

    expect(result['sections_used']).toEqual(['profile', 'charges', 'insolvency']);
    expect(harness.calls.some((call) => call.url.includes('/officers'))).toBe(false);
  });

  it('includes officers when asked, at one extra request per company', async () => {
    harness = await harnessRoutes(FULL_ROUTES);
    const result = structured(
      await harness.client.callTool({
        name: 'screen_companies',
        arguments: { companies: ['04138203'], include_officers: true }
      })
    );

    expect(result['sections_used']).toEqual(['profile', 'officers', 'charges', 'insolvency']);
    expect(harness.calls).toHaveLength(4);
  });

  it('names what it skipped rather than returning a quietly shorter table', async () => {
    // Three requests per company against a budget of four means one company
    // gets screened and the rest have to be reported, not dropped.
    harness = await harnessRoutes(FULL_ROUTES, { rateLimit: 4 });
    const result = structured(
      await harness.client.callTool({
        name: 'screen_companies',
        arguments: { companies: ['04138203', '00000006', '03782379'] }
      })
    );

    const screened = result['screened'] as unknown[];
    const notScreened = result['not_screened'] as Record<string, unknown>[];

    expect(screened.length + notScreened.length).toBe(3);
    expect(notScreened.length).toBeGreaterThan(0);
    expect(notScreened[0]?.['reason']).toContain('rate-limit budget');
    // Budget remains — just not a whole company's worth — so the window has
    // not reset and there is no honest number of seconds to quote. Saying
    // "retry in 0 seconds" would be worse than saying nothing.
    expect(notScreened[0]?.['reason']).toContain('shorter list');
    expect(notScreened[0]?.['reason']).not.toContain('Retry in 0 seconds');
  });

  it('quotes a real retry time once the window is genuinely exhausted', async () => {
    // Spend the entire window first. Now nothing is left at all, the window
    // itself is what the caller is waiting for, and the reset time is a real
    // number worth printing — unlike the case above, where budget remained.
    harness = await harnessRoutes(FULL_ROUTES, { rateLimit: 1 });
    await harness.client.callTool({
      name: 'get_company',
      arguments: { company_number: '04138203' }
    });

    const result = structured(
      await harness.client.callTool({
        name: 'screen_companies',
        arguments: { companies: ['04138203', '00000006'] }
      })
    );

    const notScreened = result['not_screened'] as Record<string, unknown>[];
    expect(notScreened.length).toBeGreaterThan(0);
    expect(notScreened[0]?.['reason']).toContain('Retry in');
    expect(notScreened[0]?.['reason']).not.toContain('Retry in 0 seconds');
  });

  it('keeps going when one company in the list fails', async () => {
    harness = await harnessRoutes([
      [/\/company\/00000006/, { status: 500 }],
      [/\/charges/, { body: CHARGES }],
      [/\/insolvency/, { body: INSOLVENCY }],
      [/\/company\//, { body: PROFILE }]
    ]);
    const result = structured(
      await harness.client.callTool({
        name: 'screen_companies',
        arguments: { companies: ['04138203', '00000006'] }
      })
    );

    expect(result['screened']).toHaveLength(1);
    expect(result['not_screened']).toHaveLength(1);
  });

  it('rejects a list longer than the documented maximum', async () => {
    harness = await harnessRoutes(FULL_ROUTES);
    const result = await harness.client.callTool({
      name: 'screen_companies',
      arguments: { companies: Array.from({ length: 51 }, (_, index) => `0000000${index}`) }
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
});
