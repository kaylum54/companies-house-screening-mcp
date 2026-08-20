import { describe, expect, it } from 'vitest';

import { CompaniesHouseClient } from '../src/http/client.js';
import { loadConfig } from '../src/config.js';

/**
 * The live smoke test.
 *
 * This is the only test that touches the real API, and it is excluded from
 * `npm test` so the suite runs offline and without a key.
 *
 * Its job is not to pass. Its job is to fail loudly, on a schedule in CI, the
 * week Companies House renames a field or changes a shape — so that the
 * recorded fixtures get refreshed before a user discovers the drift for us.
 * Fixtures make the suite fast and deterministic; this test is the price of
 * that, and skipping it is how a fixture-based suite quietly becomes fiction.
 *
 * Run with:
 *   COMPANIES_HOUSE_API_KEY=... npm run test:live
 */

const enabled = process.env['CH_LIVE_SMOKE'] === '1' && process.env['COMPANIES_HOUSE_API_KEY'] !== undefined;

describe.skipIf(!enabled)('live API smoke test', () => {
  const client = () => new CompaniesHouseClient({ config: loadConfig() });

  it('authenticates and returns a company profile with the fields we rely on', async () => {
    const { data } = await client().get<Record<string, unknown>>({
      path: '/company/00000006',
      resource: 'company-profile',
      label: 'company',
      identifier: '00000006',
      bypassCache: true
    });

    for (const field of ['company_name', 'company_number', 'company_status', 'type', 'date_of_creation']) {
      expect(data, `company profile is missing ${field}`).toHaveProperty(field);
    }
    expect(data).toHaveProperty('registered_office_address');
    expect(data).toHaveProperty('accounts');
  });

  it('returns an officer list with the counts the snapshot depends on', async () => {
    const { data } = await client().get<Record<string, unknown>>({
      path: '/company/00000006/officers',
      resource: 'officers',
      bypassCache: true
    });

    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('active_count');
    expect(Array.isArray(data['items'])).toBe(true);
  });

  it('returns search results in the documented envelope', async () => {
    const { data } = await client().get<Record<string, unknown>>({
      path: '/search/companies',
      query: { q: 'limited', items_per_page: 5 },
      resource: 'search',
      bypassCache: true
    });

    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('total_results');
  });

  it('reports a 404 for a company number that cannot exist', async () => {
    await expect(
      client().get({
        path: '/company/00000000',
        label: 'company',
        identifier: '00000000',
        bypassCache: true
      })
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('still reports a rate-limit budget after real traffic', async () => {
    const instance = client();
    await instance.get({ path: '/company/00000006', bypassCache: true });
    expect(instance.rateLimit.remaining).toBeGreaterThan(0);
  });
});
