import { describe, expect, it } from 'vitest';

import { CASES } from '../evals/cases.js';
import { scriptedSelector } from '../evals/model.js';
import { runEval } from '../evals/run.js';
import type { CaseResult } from '../evals/score.js';
import {
  findForbiddenCompanyNumbers,
  findInventedCompanyNumbers,
  scoreCase,
  summarise
} from '../evals/score.js';
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

describe('findForbiddenCompanyNumbers', () => {
  it('catches a decoy that the grounding check would wave through', () => {
    // The whole reason this check exists. The order number IS in the question,
    // so findInventedCompanyNumbers considers it grounded and says nothing.
    const question = 'We have order 12345678 outstanding with a supplier.';
    const calls = [{ name: 'get_company', input: { company_number: '12345678' } }];

    expect(findInventedCompanyNumbers(question, calls)).toEqual([]);
    expect(findForbiddenCompanyNumbers(['12345678'], calls)).toEqual(['12345678']);
  });

  it('matches regardless of punctuation and case', () => {
    expect(
      findForbiddenCompanyNumbers(['GB745938421'], [
        { name: 'get_company', input: { company_number: 'gb 745 938 421' } }
      ])
    ).toEqual(['gb 745 938 421']);
  });

  it('says nothing when the decoy was not used', () => {
    expect(
      findForbiddenCompanyNumbers(['12345678'], [
        { name: 'find_company', input: { query: 'order 12345678 supplier' } }
      ])
    ).toEqual([]);
  });

  it('checks values inside a screening list too', () => {
    expect(
      findForbiddenCompanyNumbers(['12345678'], [
        { name: 'screen_companies', input: { companies: ['Real Co', '12345678'] } }
      ])
    ).toEqual(['12345678']);
  });

  it('reports each offending value once', () => {
    expect(
      findForbiddenCompanyNumbers(['12345678', '12345678'], [
        { name: 'get_company', input: { company_number: '12345678' } }
      ])
    ).toEqual(['12345678']);
  });
});

describe('allowNoTool', () => {
  const trap = CASES.find((entry) => entry.id === 'trap-vat-number')!;

  it('lets a case pass when declining is a reasonable answer', () => {
    // Companies House cannot be searched by VAT number. Saying so is a better
    // answer than any tool call, so calling nothing has to be allowed.
    expect(scoreCase(trap, []).passed).toBe(true);
  });

  it('still fails the same case when the decoy is passed through', () => {
    const result = scoreCase(trap, [
      { name: 'get_company', input: { company_number: '745938421' } }
    ]);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name)).toContain(
      'no_forbidden_company_number'
    );
  });
});

describe('the case set is weighted for diagnosis', () => {
  it('has enough paraphrase sets to detect a vocabulary-keyed description', () => {
    const intents = new Set(
      CASES.filter((entry) => entry.category === 'paraphrase').map((entry) => entry.intent)
    );
    expect(intents.size).toBeGreaterThanOrEqual(4);

    // An intent asked only twice is a weak test of paraphrase robustness.
    for (const intent of intents) {
      const phrasings = CASES.filter((entry) => entry.intent === intent);
      expect(phrasings.length, `intent ${String(intent)} has too few phrasings`).toBeGreaterThanOrEqual(3);
    }
  });

  it('covers every category it declares', () => {
    const used = new Set(CASES.map((entry) => entry.category));
    for (const category of ['grounding', 'paraphrase', 'number-trap', 'near-miss', 'out-of-scope', 'not-uk', 'noise']) {
      expect([...used], `no case in category ${category}`).toContain(category);
    }
  });

  it('is big enough to be diagnostic without becoming filler', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(45);
    expect(CASES.length).toBeLessThanOrEqual(80);
  });
});

describe('scoreCase', () => {
  const nameCase = CASES.find((entry) => entry.id === 'grounding-profile')!;

  it('passes when the model searches first', () => {
    const result = scoreCase(nameCase, [
      { name: 'find_company', input: { query: 'Royal Mail Group Limited' } }
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
    const filing = CASES.find((entry) => entry.id === 'scope-file-statement')!;

    expect(scoreCase(filing, []).passed).toBe(true);
    expect(scoreCase(filing, [{ name: 'get_company', input: { company_number: '00000006' } }]).passed).toBe(
      false
    );
  });

  it('checks arguments only when the right tool was chosen', () => {
    // Otherwise a wrong-tool failure reports twice and the report gets noisy.
    const snapshot = CASES.find((entry) => entry.id === 'near-everything-one-company')!;
    const wrongTool = scoreCase(snapshot, [{ name: 'find_company', input: { query: 'x' } }]);

    expect(wrongTool.checks.filter((check) => check.name === 'arguments')).toHaveLength(0);
  });

  it('fails on a wrong argument even when the tool was right', () => {
    const snapshot = CASES.find((entry) => entry.id === 'near-everything-one-company')!;
    const result = scoreCase(snapshot, [
      { name: 'company_snapshot', input: { company_number: '99999999' } }
    ]);

    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === 'arguments')?.detail).toContain('99999999');
  });
});

describe('summarise', () => {
  const result = (over: Partial<CaseResult> = {}): CaseResult => ({
    id: 'a',
    category: 'grounding',
    passed: true,
    checks: [],
    calls: [],
    ...over
  });

  it('counts a case as passed only when every repeat passed', () => {
    const results = new Map([
      ['a', [result(), result()]],
      ['b', [result({ id: 'b' }), result({ id: 'b', passed: false })]]
    ]);
    const summary = summarise(results);

    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.flaky).toEqual(['b']);
  });

  it('does not call a consistently failing case flaky', () => {
    expect(summarise(new Map([['a', [result({ passed: false }), result({ passed: false })]]])).flaky).toEqual(
      []
    );
  });

  it('breaks the pass rate down by category', () => {
    // A single overall percentage says almost nothing about what to fix.
    const results = new Map([
      ['a', [result({ category: 'grounding' })]],
      ['b', [result({ id: 'b', category: 'number-trap', passed: false })]],
      ['c', [result({ id: 'c', category: 'number-trap' })]]
    ]);
    const summary = summarise(results);

    expect(summary.byCategory).toEqual([
      { category: 'grounding', passed: 1, total: 1 },
      { category: 'number-trap', passed: 1, total: 2 }
    ]);
  });

  it('reports agreement across the phrasings of one intent', () => {
    const results = new Map([
      ['a', [result({ intent: 'who-controls', chosenTool: 'get_psc' })]],
      ['b', [result({ id: 'b', intent: 'who-controls', chosenTool: 'get_psc' })]]
    ]);

    expect(summarise(results).intents).toEqual([
      { intent: 'who-controls', tools: ['get_psc'], agreed: true }
    ]);
  });

  it('flags an intent whose phrasings chose different tools', () => {
    // Four phrasings producing three tools is a finding about the
    // descriptions even when each individual choice is defensible.
    const results = new Map([
      ['a', [result({ intent: 'who-controls', chosenTool: 'get_psc' })]],
      ['b', [result({ id: 'b', intent: 'who-controls', chosenTool: 'get_officers' })]]
    ]);
    const [intent] = summarise(results).intents;

    expect(intent?.agreed).toBe(false);
    expect(intent?.tools).toEqual(['get_officers', 'get_psc']);
  });

  it('counts a tool disagreement across repeats of one phrasing too', () => {
    const results = new Map([
      [
        'a',
        [
          result({ intent: 'i', chosenTool: 'get_psc' }),
          result({ intent: 'i', chosenTool: 'company_snapshot' })
        ]
      ]
    ]);
    expect(summarise(results).intents[0]?.agreed).toBe(false);
  });
});

describe('runEval', () => {
  it('drives the real server surface with a scripted model', async () => {
    // Proves the wiring end to end without a key: real tool definitions and
    // real instructions from the server, scripted selections, real scoring.
    const cases = CASES.filter((entry) => entry.id === 'grounding-profile');
    const selector = scriptedSelector({
      [cases[0]!.question]: [{ name: 'find_company', input: { query: 'Royal Mail Group Limited' } }]
    });

    const results = await runEval(selector, cases, 2);
    expect(results.get('grounding-profile')?.every((attempt) => attempt.passed)).toBe(true);
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
