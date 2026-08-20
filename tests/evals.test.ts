import { describe, expect, it } from 'vitest';

import { CASES } from '../evals/cases.js';
import { scriptedSelector } from '../evals/model.js';
import { runEval } from '../evals/run.js';
import { findInventedCompanyNumbers, scoreCase, summarise } from '../evals/score.js';
import { COMPOSITE_TOOL_NAMES } from '../src/tools/composite.js';
import { TOOL_NAMES } from '../src/tools/definitions.js';

/**
 * Tests for the eval itself.
 *
 * The model half needs a key and costs money. The judgement half — deciding
 * whether a selection was right — needs neither, and it is the half that has
 * to be trustworthy: an eval whose scoring is wrong is worse than no eval,
 * because it produces a number people believe.
 */

const ALL_TOOLS = [...TOOL_NAMES, ...COMPOSITE_TOOL_NAMES] as string[];

describe('the eval cases', () => {
  it('only names tools that exist', () => {
    // A case referring to a renamed tool would silently never pass.
    for (const testCase of CASES) {
      for (const name of [...testCase.expectTool, ...(testCase.forbidTools ?? [])]) {
        expect(ALL_TOOLS, `${testCase.id} refers to unknown tool ${name}`).toContain(name);
      }
    }
  });

  it('has unique ids', () => {
    const ids = CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('explains why every case exists', () => {
    for (const testCase of CASES) {
      expect(testCase.why.length, `${testCase.id} has no rationale`).toBeGreaterThan(40);
    }
  });

  it('covers the design decision the server is built around', () => {
    const grounded = CASES.filter((testCase) => testCase.forbidInventedCompanyNumber === true);
    expect(grounded.length).toBeGreaterThanOrEqual(3);
  });

  it('covers every tool that a question could reasonably reach for', () => {
    const covered = new Set(CASES.flatMap((testCase) => testCase.expectTool));
    // get_charges and get_officers are reachable through company_snapshot in
    // these questions, so they are not required to be a first choice anywhere.
    const expected = ALL_TOOLS.filter((name) => !['get_charges', 'get_officers'].includes(name));
    for (const name of expected) {
      expect([...covered], `no case expects ${name}`).toContain(name);
    }
  });
});

describe('findInventedCompanyNumbers', () => {
  it('accepts a number that appears in the question', () => {
    expect(findInventedCompanyNumbers('Look up 00000006', [{ name: 'get_company', input: { company_number: '00000006' } }])).toEqual([]);
  });

  it('accepts a number written without its leading zeros', () => {
    // The model is given the benefit of the doubt: this is the same company.
    expect(
      findInventedCompanyNumbers('Look up 1234567', [
        { name: 'get_company', input: { company_number: '01234567' } }
      ])
    ).toEqual([]);
  });

  it('accepts a number buried in punctuation', () => {
    expect(
      findInventedCompanyNumbers('Registered in England no. 00000006.', [
        { name: 'get_company', input: { company_number: '00000006' } }
      ])
    ).toEqual([]);
  });

  it('catches a number that came from nowhere', () => {
    expect(
      findInventedCompanyNumbers('Tell me about Greggs plc', [
        { name: 'get_company', input: { company_number: '00502851' } }
      ])
    ).toEqual(['00502851']);
  });

  it('does not treat a company name as an invented number', () => {
    expect(
      findInventedCompanyNumbers('Screen these', [
        { name: 'screen_companies', input: { companies: ['Greggs plc', 'Example Trading Limited'] } }
      ])
    ).toEqual([]);
  });

  it('catches an invented number inside a screening list', () => {
    expect(
      findInventedCompanyNumbers('Screen Greggs plc', [
        { name: 'screen_companies', input: { companies: ['Greggs plc', '00502851'] } }
      ])
    ).toEqual(['00502851']);
  });
});

describe('scoreCase', () => {
  const nameCase = CASES.find((entry) => entry.id === 'name-only-profile')!;

  it('passes when the model searches first', () => {
    const result = scoreCase(nameCase, [
      { name: 'find_company', input: { query: 'Example Fixture Trading Limited' } }
    ]);
    expect(result.passed).toBe(true);
  });

  it('fails when the model guesses a number instead', () => {
    const result = scoreCase(nameCase, [{ name: 'get_company', input: { company_number: '01234567' } }]);

    expect(result.passed).toBe(false);
    const failed = result.checks.filter((check) => !check.passed).map((check) => check.name);
    expect(failed).toContain('tool_choice');
    expect(failed).toContain('no_forbidden_tools');
    expect(failed).toContain('no_invented_company_number');
  });

  it('fails when no tool is called but one was expected', () => {
    const result = scoreCase(nameCase, []);
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.detail).toContain('no tool was called');
  });

  it('passes an out-of-scope case only when nothing is called', () => {
    const filing = CASES.find((entry) => entry.id === 'out-of-scope-filing')!;

    expect(scoreCase(filing, []).passed).toBe(true);
    expect(scoreCase(filing, [{ name: 'get_company', input: { company_number: '00000006' } }]).passed).toBe(
      false
    );
  });

  it('checks arguments only when the right tool was chosen', () => {
    // Otherwise a wrong-tool failure reports twice and the report gets noisy.
    const snapshot = CASES.find((entry) => entry.id === 'snapshot-over-primitives')!;
    const wrongTool = scoreCase(snapshot, [{ name: 'find_company', input: { query: 'x' } }]);

    expect(wrongTool.checks.filter((check) => check.name === 'arguments')).toHaveLength(0);
  });

  it('fails on a wrong argument even when the tool was right', () => {
    const snapshot = CASES.find((entry) => entry.id === 'snapshot-over-primitives')!;
    const result = scoreCase(snapshot, [
      { name: 'company_snapshot', input: { company_number: '99999999' } }
    ]);

    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === 'arguments')?.detail).toContain('99999999');
  });
});

describe('summarise', () => {
  const pass = { id: 'a', passed: true, checks: [], calls: [] };
  const fail = { id: 'a', passed: false, checks: [], calls: [] };

  it('counts a case as passed only when every repeat passed', () => {
    const results = new Map([
      ['a', [pass, pass]],
      ['b', [{ ...pass, id: 'b' }, { ...fail, id: 'b' }]]
    ]);
    const summary = summarise(results);

    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.flaky).toEqual(['b']);
  });

  it('does not call a consistently failing case flaky', () => {
    expect(summarise(new Map([['a', [fail, fail]]])).flaky).toEqual([]);
  });
});

describe('runEval', () => {
  it('drives the real server surface with a scripted model', async () => {
    // Proves the wiring end to end without a key: real tool definitions and
    // real instructions from the server, scripted selections, real scoring.
    const cases = CASES.filter((entry) => entry.id === 'name-only-profile');
    const selector = scriptedSelector({
      [cases[0]!.question]: [{ name: 'find_company', input: { query: 'Example Fixture Trading Limited' } }]
    });

    const results = await runEval(selector, cases, 2);
    expect(results.get('name-only-profile')?.every((attempt) => attempt.passed)).toBe(true);
  });

  it('sends the server instructions to the model', async () => {
    let seenSystem = '';
    const selector = {
      label: 'spy',
      select: async (_question: string, system: string) => {
        seenSystem = system;
        return [];
      }
    };

    await runEval(selector, CASES.slice(0, 1), 1);

    // The instructions are part of what the eval tests: "prefer
    // company_snapshot" and "never guess a number" either change behaviour
    // here or they are decoration.
    expect(seenSystem).toContain('Do not guess a number');
    expect(seenSystem).toContain('company_snapshot');
  });

  it('offers the model every tool the server publishes', async () => {
    let seenTools: string[] = [];
    const selector = {
      label: 'spy',
      select: async (_question: string, _system: string, tools: { name: string }[]) => {
        seenTools = tools.map((tool) => tool.name);
        return [];
      }
    };

    await runEval(selector, CASES.slice(0, 1), 1);
    expect(seenTools.sort()).toEqual([...ALL_TOOLS].sort());
  });
});
