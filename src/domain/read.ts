/**
 * Defensive readers for upstream payloads.
 *
 * A note on why these exist rather than a Zod schema over the Companies House
 * response.
 *
 * Validating *their* payload strictly means that the day Companies House adds
 * a field, renames one, or returns `null` where it used to return a string,
 * every call fails. The failure is total and it is caused by a change that
 * did not affect anything we actually read.
 *
 * So: read the upstream loosely, and validate strictly on the way out. If a
 * field we want is missing, that field is missing from the projection and the
 * rest of the answer still arrives. Our output schema is the contract we
 * control and the one worth enforcing.
 */

export function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function pick(source: unknown, key: string): unknown {
  return obj(source)[key];
}

export function str(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  // Companies House returns some numeric-looking fields as numbers and some
  // as strings, inconsistently between endpoints.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Reads a nested path, returning undefined rather than throwing at any level. */
export function path(source: unknown, ...keys: string[]): unknown {
  let current = source;
  for (const key of keys) {
    current = obj(current)[key];
    if (current === undefined || current === null) return undefined;
  }
  return current;
}
