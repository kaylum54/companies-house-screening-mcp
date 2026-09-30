import { describe, expect, it } from 'vitest';
import { classifyDeadline, validDate } from '../src/tools/deadlines.js';
import { harnessRoutes, structured } from './helpers/harness.js';
import { loadFixture } from './helpers/support.js';

describe('filing deadline classification', () => {
  it.each([
    ['2026-09-15', 'overdue', -1], ['2026-09-16', 'due_soon', 0],
    ['2026-10-16', 'due_soon', 30], ['2026-10-17', 'later', 31]
  ])('classifies %s at the inclusive window boundary', (date, category, days) => {
    expect(classifyDeadline(date, '2026-09-16', 30)).toMatchObject({ category, days_until_due: days });
  });
  it('keeps register flags separate from the chosen comparison date', () => {
    expect(classifyDeadline('2026-10-17', '2026-09-16', 30, true)).toMatchObject({ category: 'later', register_overdue: true });
  });
  it('handles leap days and rejects normalized invalid dates', () => {
    expect(validDate('2028-02-29')).toBe(true);
    expect(validDate('2026-02-29')).toBe(false);
    expect(classifyDeadline('2026-02-30', '2026-09-16', 30).category).toBe('unknown');
    expect(classifyDeadline(undefined, '2026-09-16', 30).category).toBe('unknown');
    expect(classifyDeadline('2028-03-01', '2028-02-28', 2).days_until_due).toBe(2);
  });
});

describe('accountant worksheet through MCP', () => {
  const profile = loadFixture<Record<string, unknown>>('company/profile-active.json');
  it('retains duplicate references and invalid rows, fetches only one profile, and classifies dates', async () => {
    const h = await harnessRoutes([[/\/company\/04138203$/, { body: { ...profile,
      accounts: { next_due: '2026-09-15' }, confirmation_statement: { next_due: '2026-10-16' } } }]]);
    try {
      const result = structured(await h.client.callTool({ name: 'review_filing_deadlines', arguments: {
        clients: [{ company_number: '04138203', client_reference: 'C001' }, { company_number: '4138203', client_reference: 'C002' },
          { company_number: '  ', client_reference: 'C003' }], as_of: '2026-09-16', horizon_days: 30
      } }));
      expect(result).toMatchObject({ requested: 3, checked: 2, not_screened: 1, window_end: '2026-10-16' });
      expect(result['rows']).toEqual([
        expect.objectContaining({ input_index: 0, client_reference: 'C001', accounts: expect.objectContaining({ category: 'overdue' }), confirmation_statement: expect.objectContaining({ category: 'due_soon' }) }),
        expect.objectContaining({ input_index: 1, client_reference: 'C002', company_number: '04138203' }),
        expect.objectContaining({ input_index: 2, client_reference: 'C003', outcome: 'not_screened' })
      ]);
      expect(h.calls).toHaveLength(1);
    } finally { await h.close(); }
  });
  it('keeps failed and missing-date profiles distinct', async () => {
    const h = await harnessRoutes([
      [/\/company\/00000001$/, { body: { ...profile, accounts: {}, confirmation_statement: {} } }],
      [/\/company\/00000002$/, { status: 403 }]
    ]);
    try {
      const result = structured(await h.client.callTool({ name: 'review_filing_deadlines', arguments: {
        clients: [{ company_number: '1' }, { company_number: '2' }]
      } }));
      expect(result['rows']).toEqual([
        expect.objectContaining({ outcome: 'checked', accounts: expect.objectContaining({ category: 'unknown' }), sections_unavailable: [] }),
        expect.objectContaining({ outcome: 'not_screened', sections_unavailable: ['profile'] })
      ]);
      expect(result['as_of']).toBe('2026-08-20');
    } finally { await h.close(); }
  });
  it('accounts for the rows that do not fit the budget', async () => {
    const h = await harnessRoutes([[/\/company\//, { body: profile }]], { rateLimit: 2 });
    try {
      const result = structured(await h.client.callTool({ name: 'review_filing_deadlines', arguments: {
        clients: [{ company_number: '1' }, { company_number: '2' }, { company_number: '3' }]
      } }));
      expect(result).toMatchObject({ requested: 3, checked: 1, not_screened: 2 });
      expect(h.calls).toHaveLength(1);
    } finally { await h.close(); }
  });
  it('checks fresh cached profiles even when no API budget remains', async () => {
    const h = await harnessRoutes([[/\/company\/00000001$/, { body: profile }]], { rateLimit: 1, cacheEnabled: true });
    try {
      await h.client.callTool({ name: 'get_company', arguments: { company_number: '1' } });
      const result = structured(await h.client.callTool({ name: 'review_filing_deadlines', arguments: {
        clients: [{ company_number: '1' }]
      } }));

      expect(result).toMatchObject({ checked: 1, not_screened: 0 });
      expect(result['rows']).toEqual([expect.objectContaining({ outcome: 'checked', meta: expect.objectContaining({ cached: true }) })]);
      expect(h.calls).toHaveLength(1);
    } finally { await h.close(); }
  });
  it('keeps cached rows while marking uncached rows not screened at zero budget', async () => {
    const h = await harnessRoutes([[/\/company\/00000001$/, { body: profile }]], { rateLimit: 1, cacheEnabled: true });
    try {
      await h.client.callTool({ name: 'get_company', arguments: { company_number: '1' } });
      const result = structured(await h.client.callTool({ name: 'review_filing_deadlines', arguments: {
        clients: [{ company_number: '1' }, { company_number: '2' }]
      } }));

      expect(result).toMatchObject({ checked: 1, not_screened: 1 });
      expect(result['rows']).toEqual([
        expect.objectContaining({ input_company_number: '1', outcome: 'checked', meta: expect.objectContaining({ cached: true }) }),
        expect.objectContaining({ input_company_number: '2', outcome: 'not_screened' })
      ]);
      expect(h.calls).toHaveLength(1);
    } finally { await h.close(); }
  });
  it('does not silently use a fresh cache entry when refresh is requested', async () => {
    const h = await harnessRoutes([[/\/company\/00000001$/, { body: profile }]], { rateLimit: 1, cacheEnabled: true });
    try {
      await h.client.callTool({ name: 'get_company', arguments: { company_number: '1' } });
      const result = structured(await h.client.callTool({ name: 'review_filing_deadlines', arguments: {
        clients: [{ company_number: '1' }], refresh: true
      } }));

      expect(result).toMatchObject({ checked: 0, not_screened: 1 });
      expect(result['rows']).toEqual([expect.objectContaining({ outcome: 'not_screened' })]);
      expect(h.calls).toHaveLength(1);
    } finally { await h.close(); }
  });
  it('rejects an impossible comparison date before I/O', async () => {
    const h = await harnessRoutes([]);
    try {
      const result = await h.client.callTool({ name: 'review_filing_deadlines', arguments: {
        clients: [{ company_number: '1' }], as_of: '2026-02-30'
      } });
      expect(result.isError).toBe(true);
      expect(h.calls).toHaveLength(0);
    } finally { await h.close(); }
  });
});
