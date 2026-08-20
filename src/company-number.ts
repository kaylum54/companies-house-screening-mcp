import { invalidCompanyNumber } from './errors.js';

/**
 * Company number handling.
 *
 * Two facts drive this module:
 *
 * 1. Companies House numbers are always eight characters, but almost nobody
 *    writes them that way. Invoices, spreadsheets and humans drop the leading
 *    zeros, so "1234567" and "01234567" are the same company and only one of
 *    them is accepted by the API.
 * 2. A wrong-but-well-formed company number is the worst failure mode in this
 *    domain. It returns a real company with a real director list, and nothing
 *    downstream marks it as the wrong one. So normalisation is deliberately
 *    conservative: it fixes formatting, and it never guesses.
 */

const NON_ALPHANUMERIC = /[\s.\-/]/g;
const COMPANY_NUMBER_PATTERN = /^[A-Z0-9]{2}[0-9]{6}$/;
const ALL_DIGITS = /^[0-9]+$/;

/**
 * Registration prefixes in use at the time of writing. This list exists to
 * make error messages helpful and to power a soft warning; it is deliberately
 * *not* used to reject input, because Companies House adds prefixes and a
 * hard allowlist would turn that into an outage for anyone using this server.
 */
export const KNOWN_PREFIXES = [
  'AC', 'CE', 'CS', 'FC', 'GE', 'GN', 'GS', 'IC', 'IP', 'LP', 'NA', 'NC', 'NF',
  'NI', 'NL', 'NO', 'NP', 'NR', 'NV', 'NZ', 'OC', 'OE', 'PC', 'R0', 'RC', 'RS',
  'SA', 'SC', 'SE', 'SF', 'SG', 'SI', 'SL', 'SO', 'SP', 'SR', 'SZ', 'ZC'
] as const;

export interface NormalisedCompanyNumber {
  /** The eight-character value to send to the API. */
  value: string;
  /** True when leading zeros were added to reach eight characters. */
  padded: boolean;
  /** Set when the prefix is not one this library recognises. Informational. */
  unknownPrefix?: string;
}

/**
 * Normalises loosely-formatted input into an eight-character company number.
 *
 * Accepts: "01234567", "1234567", "SC 123 456", "oc-123456".
 * Rejects anything that is not eight characters after cleaning, and anything
 * whose last six characters are not digits.
 *
 * @throws {CompaniesHouseError} with code INVALID_COMPANY_NUMBER
 */
export function normaliseCompanyNumber(input: string): NormalisedCompanyNumber {
  if (typeof input !== 'string') {
    throw invalidCompanyNumber(String(input), 'it is not a string');
  }

  const cleaned = input.trim().replace(NON_ALPHANUMERIC, '').toUpperCase();

  if (cleaned.length === 0) {
    throw invalidCompanyNumber(input, 'it is empty');
  }

  let padded = false;
  let candidate = cleaned;

  // Purely numeric input is zero-padded. This is the single most common form
  // of malformed input and the only case where the correct value is
  // unambiguous.
  if (ALL_DIGITS.test(candidate) && candidate.length < 8) {
    candidate = candidate.padStart(8, '0');
    padded = true;
  }

  if (candidate.length !== 8) {
    throw invalidCompanyNumber(
      input,
      `it is ${candidate.length} characters after removing spaces and punctuation, and company numbers are 8`
    );
  }

  if (!COMPANY_NUMBER_PATTERN.test(candidate)) {
    throw invalidCompanyNumber(
      input,
      'the last six characters must be digits, preceded by two digits or a two-letter prefix such as SC or NI'
    );
  }

  const prefix = candidate.slice(0, 2);
  const result: NormalisedCompanyNumber = { value: candidate, padded };

  if (!ALL_DIGITS.test(prefix) && !(KNOWN_PREFIXES as readonly string[]).includes(prefix)) {
    result.unknownPrefix = prefix;
  }

  return result;
}

/** Non-throwing variant, for places that want to branch rather than catch. */
export function isValidCompanyNumber(input: string): boolean {
  try {
    normaliseCompanyNumber(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a string looks more like a company name than a company number.
 * Used to give a better error than "invalid" when someone passes "Greggs plc"
 * to a tool that requires a number.
 */
export function looksLikeCompanyName(input: string): boolean {
  const cleaned = input.trim();
  if (cleaned.length === 0) return false;
  if (isValidCompanyNumber(cleaned)) return false;
  return /[a-z]{3,}/i.test(cleaned);
}
