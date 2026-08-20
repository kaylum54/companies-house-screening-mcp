import { arr, num, obj, path, str } from './read.js';

/**
 * Presentation helpers shared by the projections.
 */

const ADDRESS_PARTS = [
  'care_of',
  'po_box',
  'premises',
  'address_line_1',
  'address_line_2',
  'locality',
  'region',
  'postal_code',
  'country'
] as const;

/**
 * Flattens a Companies House address object into one line.
 *
 * The structured form runs to nine keys, most of them empty, and it appears on
 * every company, every officer and every search hit. One string carries the
 * same information at a fraction of the size, and it is the form a person
 * would compare against an invoice anyway. The structured original is still
 * available through `verbose`.
 */
export function formatAddress(value: unknown): string | undefined {
  const source = obj(value);
  const parts = ADDRESS_PARTS.map((key) => str(source[key])).filter(
    (part): part is string => part !== undefined
  );
  return parts.length === 0 ? undefined : parts.join(', ');
}

/**
 * Company type slugs, where the slug is misleading on its own. `ltd` is the
 * important one: it is by far the most common value and it does not say
 * "private" anywhere.
 *
 * Anything not listed falls back to a prettified slug, so a type introduced
 * after this was written still reads sensibly instead of disappearing.
 */
const COMPANY_TYPES: Record<string, string> = {
  ltd: 'Private limited company',
  plc: 'Public limited company',
  llp: 'Limited liability partnership',
  'limited-partnership': 'Limited partnership',
  'private-unlimited': 'Private unlimited company',
  'private-unlimited-nsc': 'Private unlimited company without share capital',
  'private-limited-guarant-nsc': 'Private company limited by guarantee without share capital',
  'private-limited-guarant-nsc-limited-exemption':
    'Private company limited by guarantee without share capital, exempt from using "limited"',
  'private-limited-shares-section-30-exemption':
    'Private limited company, exempt from using "limited"',
  'old-public-company': 'Old public company',
  'oversea-company': 'Overseas company',
  'uk-establishment': 'UK establishment of an overseas company',
  'scottish-partnership': 'Scottish partnership',
  'charitable-incorporated-organisation': 'Charitable incorporated organisation',
  'scottish-charitable-incorporated-organisation': 'Scottish charitable incorporated organisation',
  'registered-society-non-jurisdictional': 'Registered society',
  'industrial-and-provident-society': 'Industrial and provident society',
  'royal-charter': 'Royal charter company',
  'community-interest-company': 'Community interest company',
  'northern-ireland': 'Northern Ireland company',
  'northern-ireland-other': 'Northern Ireland company (other)',
  eeig: 'European economic interest grouping',
  'further-education-or-sixth-form-college-corporation':
    'Further education or sixth form college corporation'
};

export function describeCompanyType(value: unknown): string | undefined {
  const slug = str(value);
  if (slug === undefined) return undefined;
  const known = COMPANY_TYPES[slug];
  if (known !== undefined) return known;
  const words = slug.replace(/[-_]/g, ' ').trim();
  return words === '' ? undefined : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Whole years between an ISO date and `now`, or undefined if unparseable. */
export function yearsSince(isoDate: unknown, now: number): number | undefined {
  const value = str(isoDate);
  if (value === undefined) return undefined;
  const then = Date.parse(value);
  if (!Number.isFinite(then) || then > now) return undefined;
  return Math.floor((now - then) / (365.25 * 24 * 60 * 60 * 1000));
}

/**
 * Companies House gives an officer's date of birth as month and year only,
 * for the good reason that a full date is a fraud risk. Rendered as `1979-07`
 * so nobody mistakes it for a complete date.
 */
export function formatPartialDateOfBirth(value: unknown): string | undefined {
  const source = obj(value);
  const year = num(source['year']);
  const month = num(source['month']);
  if (year === undefined) return undefined;
  if (month === undefined) return String(year);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Extracts the officer identifier from an appointments link.
 *
 * The officer ID never appears as a field of its own; it is only present
 * inside `/officers/{id}/appointments`. Without pulling it out here, a caller
 * that has just listed a board has no way to look any of them up, which is
 * exactly the conflict-of-interest question people want to ask.
 */
export function officerIdFromLink(value: unknown): string | undefined {
  const link = str(value);
  if (link === undefined) return undefined;
  const match = /\/officers\/([^/]+)(?:\/|$)/.exec(link);
  return match?.[1];
}

/** Reads the officer appointments link wherever the endpoint happens to put it. */
export function officerIdFromItem(item: unknown): string | undefined {
  return (
    officerIdFromLink(path(item, 'links', 'officer', 'appointments')) ??
    officerIdFromLink(path(item, 'links', 'self')) ??
    officerIdFromLink(path(item, 'links', 'officer', 'self'))
  );
}

/** Pagination envelope, normalised across endpoints that spell it differently. */
export interface Pagination {
  start_index: number;
  items_per_page: number;
  total_results: number;
  returned: number;
  has_more: boolean;
}

export function pagination(payload: unknown, returned: number): Pagination {
  const source = obj(payload);
  const startIndex = num(source['start_index']) ?? 0;
  const itemsPerPage = num(source['items_per_page']) ?? returned;
  // Search uses `total_results`; advanced search uses `hits`; charges and a
  // few others use `total_count`.
  const total =
    num(source['total_results']) ?? num(source['hits']) ?? num(source['total_count']) ?? returned;

  return {
    start_index: startIndex,
    items_per_page: itemsPerPage,
    total_results: total,
    returned,
    has_more: startIndex + returned < total
  };
}

/** Names of the parties entitled to a charge, deduplicated. */
export function personsEntitled(value: unknown): string[] {
  const names = arr(value)
    .map((entry) => str(obj(entry)['name']))
    .filter((name): name is string => name !== undefined);
  return [...new Set(names)];
}
