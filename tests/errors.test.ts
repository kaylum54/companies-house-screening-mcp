import { describe, expect, it } from 'vitest';

import {
  CompaniesHouseError,
  ERROR_CODES,
  fromHttpStatus,
  invalidCompanyNumber,
  malformedResponse,
  networkError,
  timeout
} from '../src/errors.js';

describe('the error contract', () => {
  it('gives every error a next step', () => {
    // This is the whole design. A model that receives "not found" retries the
    // same call; a model that receives "not found, search by name with
    // find_company" does something useful.
    const errors = [
      fromHttpStatus({ status: 404, resource: 'company', identifier: '00000006' }),
      fromHttpStatus({ status: 401, resource: 'company' }),
      fromHttpStatus({ status: 403, resource: 'company' }),
      fromHttpStatus({ status: 429, resource: 'company', retryAfterMs: 30_000 }),
      fromHttpStatus({ status: 500, resource: 'company' }),
      fromHttpStatus({ status: 400, resource: 'company' }),
      fromHttpStatus({ status: 418, resource: 'company' }),
      invalidCompanyNumber('nope', 'it is wrong'),
      timeout('company', 5000),
      networkError('company', new Error('ECONNREFUSED')),
      malformedResponse('company', new Error('bad json'))
    ];

    for (const error of errors) {
      expect(error.nextStep.length).toBeGreaterThan(20);
      expect(ERROR_CODES).toContain(error.code);
      expect(error.message).not.toContain('    at ');
    }
  });

  it('marks transient failures retryable and permanent ones not', () => {
    expect(fromHttpStatus({ status: 429, resource: 'c' }).retryable).toBe(true);
    expect(fromHttpStatus({ status: 503, resource: 'c' }).retryable).toBe(true);
    expect(timeout('c', 1000).retryable).toBe(true);
    expect(networkError('c', new Error('x')).retryable).toBe(true);

    // Retrying a bad key or a missing company just burns the rate limit.
    expect(fromHttpStatus({ status: 401, resource: 'c' }).retryable).toBe(false);
    expect(fromHttpStatus({ status: 404, resource: 'c' }).retryable).toBe(false);
    expect(fromHttpStatus({ status: 400, resource: 'c' }).retryable).toBe(false);
  });

  it('names the subject in a 404 so the message is actionable', () => {
    const error = fromHttpStatus({ status: 404, resource: 'company', identifier: '00000006' });
    expect(error.message).toContain('company 00000006');
    expect(error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('turns a retry-after into plain words', () => {
    const error = fromHttpStatus({ status: 429, resource: 'company', retryAfterMs: 30_000 });
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.nextStep).toContain('30 seconds');
    expect(error.retryAfterMs).toBe(30_000);
  });

  it('says a bad key is a configuration problem, not a transient one', () => {
    const error = fromHttpStatus({ status: 401, resource: 'company' });
    expect(error.code).toBe('AUTH_INVALID');
    expect(error.nextStep).toContain('retrying will not fix it');
  });

  it('serialises to a snake_case payload without leaking internals', () => {
    const payload = fromHttpStatus({ status: 429, resource: 'company', retryAfterMs: 1000 }).toPayload();
    expect(payload).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: expect.stringContaining('rate limit'),
        next_step: expect.any(String),
        status: 429,
        retry_after_ms: 1000,
        retryable: true
      }
    });
    expect(JSON.stringify(payload)).not.toContain('stack');
  });

  it('omits optional fields rather than emitting nulls', () => {
    const payload = invalidCompanyNumber('x', 'reason').toPayload();
    expect('status' in payload.error).toBe(false);
    expect('retry_after_ms' in payload.error).toBe(false);
  });

  it('preserves the cause for logging', () => {
    const cause = new Error('underlying');
    expect(networkError('company', cause).cause).toBe(cause);
  });

  it('identifies its own errors', () => {
    expect(CompaniesHouseError.is(timeout('c', 1))).toBe(true);
    expect(CompaniesHouseError.is(new Error('other'))).toBe(false);
    expect(CompaniesHouseError.is(undefined)).toBe(false);
  });
});
