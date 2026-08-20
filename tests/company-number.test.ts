import { describe, expect, it } from 'vitest';

import {
  isValidCompanyNumber,
  looksLikeCompanyName,
  normaliseCompanyNumber
} from '../src/company-number.js';
import { CompaniesHouseError } from '../src/errors.js';

describe('normaliseCompanyNumber', () => {
  it('passes through a well-formed eight-digit number', () => {
    const result = normaliseCompanyNumber('01234567');
    expect(result.value).toBe('01234567');
    expect(result.padded).toBe(false);
  });

  it('zero-pads short numeric input, which is how humans write it', () => {
    expect(normaliseCompanyNumber('1234567').value).toBe('01234567');
    expect(normaliseCompanyNumber('6').value).toBe('00000006');
    expect(normaliseCompanyNumber('1234567').padded).toBe(true);
  });

  it('uppercases and strips the punctuation people paste in', () => {
    expect(normaliseCompanyNumber('sc 123 456').value).toBe('SC123456');
    expect(normaliseCompanyNumber('oc-123456').value).toBe('OC123456');
    expect(normaliseCompanyNumber('  NI123456  ').value).toBe('NI123456');
  });

  it('flags an unrecognised prefix without rejecting it', () => {
    // Companies House adds prefixes. A hard allowlist would turn that into an
    // outage, so unknown prefixes are reported and allowed through.
    const result = normaliseCompanyNumber('QQ123456');
    expect(result.value).toBe('QQ123456');
    expect(result.unknownPrefix).toBe('QQ');
  });

  it('does not flag a known prefix', () => {
    expect(normaliseCompanyNumber('SC123456').unknownPrefix).toBeUndefined();
  });

  it.each([
    ['', 'it is empty'],
    ['   ', 'it is empty'],
    ['123456789', '9 characters'],
    ['SC12345', '7 characters'],
    ['ABCDEFGH', 'last six characters must be digits'],
    ['1234567A', 'last six characters must be digits']
  ])('rejects %j', (input, fragment) => {
    expect(() => normaliseCompanyNumber(input)).toThrowError(CompaniesHouseError);
    try {
      normaliseCompanyNumber(input);
    } catch (error) {
      expect(CompaniesHouseError.is(error)).toBe(true);
      const typed = error as CompaniesHouseError;
      expect(typed.code).toBe('INVALID_COMPANY_NUMBER');
      expect(typed.message).toContain(fragment);
      // The point of the error model: it always says what to do next.
      expect(typed.nextStep).toContain('find_company');
    }
  });

  it('never guesses when input is ambiguous', () => {
    // "Alphanumeric but wrong length" has no single correct repair, so it is
    // rejected rather than trimmed or padded into something plausible.
    expect(() => normaliseCompanyNumber('SC1234567')).toThrowError();
  });
});

describe('isValidCompanyNumber', () => {
  it('branches without throwing', () => {
    expect(isValidCompanyNumber('00000006')).toBe(true);
    expect(isValidCompanyNumber('nonsense')).toBe(false);
  });
});

describe('looksLikeCompanyName', () => {
  it('recognises a name so the error can be specific', () => {
    expect(looksLikeCompanyName('Example Fixture Trading Limited')).toBe(true);
    expect(looksLikeCompanyName('greggs')).toBe(true);
  });

  it('does not treat a valid number as a name', () => {
    expect(looksLikeCompanyName('SC123456')).toBe(false);
    expect(looksLikeCompanyName('00000006')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(looksLikeCompanyName('   ')).toBe(false);
  });
});
