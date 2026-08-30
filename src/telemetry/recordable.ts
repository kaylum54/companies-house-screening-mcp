/**
 * The values the analytics layer is allowed to record.
 *
 * Kept here rather than in `metrics.ts` so that the recorder itself stays free
 * of any dependency on the tool registry — it takes the sets as data. And kept
 * as a derivation of the real registries rather than a hand-written copy, so a
 * tool added next year is recordable without anybody remembering this file,
 * and a tool removed stops being recordable without a stale entry lingering.
 */

import { ERROR_CODES } from '../errors.js';
import { COMPOSITE_TOOL_NAMES } from '../tools/composite.js';
import { TOOL_NAMES } from '../tools/definitions.js';

/**
 * Every tool, plus the two non-tool rows this server writes.
 *
 * `unknown` is what an MCP request that never reached a handler records — a
 * handshake, a `tools/list`, or a call the SDK rejected before `guard` ran.
 * `heartbeat` is the scheduled check.
 */
export const RECORDABLE_TOOLS: readonly string[] = [
  ...TOOL_NAMES,
  ...COMPOSITE_TOOL_NAMES,
  'unknown',
  'heartbeat'
];

/**
 * Every typed error code, plus the ones raised outside `CompaniesHouseError`.
 *
 * These name failures of the deployment rather than of a lookup, which is
 * exactly the distinction an operator needs and the one the analytics was
 * previously blind to.
 */
export const RECORDABLE_ERROR_CODES: readonly string[] = [
  ...ERROR_CODES,
  'internal_error',
  'misconfigured',
  'origin_rejected',
  'unauthorised',
  // Answered by the MCP SDK above this server's handlers: a malformed body, an
  // unknown method, an unknown tool, or arguments that failed the schema.
  'protocol_error'
];
