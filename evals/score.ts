import type { ArgAssertion, EvalCase } from './cases.js';

/**
 * Scoring, kept pure.
 *
 * The model call is the expensive, non-deterministic half. The judgement about
 * whether a selection was right is neither, so it lives here where it can be
 * tested exhaustively with no key and no network — which is what stops the
 * eval itself from being the thing nobody trusts.
 */

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export type CheckName =
  | 'tool_choice'
  | 'no_forbidden_tools'
  | 'arguments'
  | 'no_invented_company_number';

export interface Check {
  name: CheckName;
  passed: boolean;
  detail: string;
}

export interface CaseResult {
  id: string;
  passed: boolean;
  checks: Check[];
  calls: ToolCall[];
}

/** Reads a dotted path out of a tool call's arguments. */
function readPath(input: Record<string, unknown>, path: string): unknown {
  let current: unknown = input;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function checkArgument(call: ToolCall, assertion: ArgAssertion): Check {
  const actual = readPath(call.input, assertion.path);
  const rendered = actual === undefined ? '(absent)' : String(actual);

  if (assertion.equals !== undefined) {
    return {
      name: 'arguments',
      passed: rendered === assertion.equals,
      detail: `${assertion.path} expected "${assertion.equals}", got "${rendered}"`
    };
  }

  if (assertion.contains !== undefined) {
    return {
      name: 'arguments',
      passed: rendered.toLowerCase().includes(assertion.contains.toLowerCase()),
      detail: `${assertion.path} expected to contain "${assertion.contains}", got "${rendered}"`
    };
  }

  return { name: 'arguments', passed: true, detail: `${assertion.path} had no assertion` };
}

/** Digits and letters only, so "00000006" matches "no. 00000006". */
const squash = (value: string): string => value.replace(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * Catches a company number the model produced from nowhere.
 *
 * The comparison is deliberately generous to the model: a number counts as
 * grounded if it appears in the question in any form, including without its
 * leading zeros. Anything that survives that is genuinely invented, which in
 * this domain returns a real company with real directors and no warning
 * attached.
 */
export function findInventedCompanyNumbers(question: string, calls: ToolCall[]): string[] {
  const haystack = squash(question);
  const invented: string[] = [];

  for (const call of calls) {
    const candidates: string[] = [];
    const direct = call.input['company_number'];
    if (typeof direct === 'string') candidates.push(direct);

    const list = call.input['companies'];
    if (Array.isArray(list)) {
      for (const entry of list) if (typeof entry === 'string') candidates.push(entry);
    }

    for (const candidate of candidates) {
      const squashed = squash(candidate);
      if (squashed === '') continue;
      // Not a number at all — a name passed to screen_companies is fine.
      if (!/\d/.test(squashed)) continue;
      const withoutLeadingZeros = squashed.replace(/^0+/, '');
      if (haystack.includes(squashed) || haystack.includes(withoutLeadingZeros)) continue;
      invented.push(candidate);
    }
  }

  return invented;
}

export function scoreCase(testCase: EvalCase, calls: ToolCall[]): CaseResult {
  const checks: Check[] = [];
  const first = calls[0];

  if (testCase.expectTool.length === 0) {
    checks.push({
      name: 'tool_choice',
      passed: calls.length === 0,
      detail:
        calls.length === 0
          ? 'called no tool, as expected'
          : `expected no tool call, got ${calls.map((call) => call.name).join(', ')}`
    });
  } else {
    checks.push({
      name: 'tool_choice',
      passed: first !== undefined && testCase.expectTool.includes(first.name),
      detail:
        first === undefined
          ? `expected one of [${testCase.expectTool.join(', ')}], no tool was called`
          : `expected one of [${testCase.expectTool.join(', ')}], got ${first.name}`
    });
  }

  if (testCase.forbidTools !== undefined) {
    const used = calls.filter((call) => testCase.forbidTools?.includes(call.name));
    checks.push({
      name: 'no_forbidden_tools',
      passed: used.length === 0,
      detail:
        used.length === 0
          ? 'avoided every forbidden tool'
          : `called forbidden tool(s): ${used.map((call) => call.name).join(', ')}`
    });
  }

  // Argument assertions apply to the first call, and only when that call was
  // the expected one — otherwise a wrong-tool failure reports twice.
  if (testCase.expectArgs !== undefined && first !== undefined && testCase.expectTool.includes(first.name)) {
    for (const assertion of testCase.expectArgs) checks.push(checkArgument(first, assertion));
  }

  if (testCase.forbidInventedCompanyNumber === true) {
    const invented = findInventedCompanyNumbers(testCase.question, calls);
    checks.push({
      name: 'no_invented_company_number',
      passed: invented.length === 0,
      detail:
        invented.length === 0
          ? 'passed no company number that was not in the question'
          : `invented company number(s): ${invented.join(', ')}`
    });
  }

  return { id: testCase.id, passed: checks.every((check) => check.passed), checks, calls };
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  /** Cases that passed on some repeats and failed on others. */
  flaky: string[];
}

export function summarise(resultsByCase: Map<string, CaseResult[]>): RunSummary {
  let passed = 0;
  const flaky: string[] = [];

  for (const [id, results] of resultsByCase) {
    const passes = results.filter((result) => result.passed).length;
    // A case that passes sometimes is a case whose tool descriptions are
    // ambiguous. Reporting it as a plain pass would hide the ambiguity.
    if (passes > 0 && passes < results.length) flaky.push(id);
    if (passes === results.length) passed += 1;
  }

  const total = resultsByCase.size;
  return {
    total,
    passed,
    failed: total - passed,
    passRate: total === 0 ? 0 : passed / total,
    flaky
  };
}
