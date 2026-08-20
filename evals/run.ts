/**
 * Runs the tool-selection eval against a real model.
 *
 *   npm run eval
 *   npm run eval -- --repeat 3
 *   npm run eval -- --provider openrouter --model anthropic/claude-sonnet-5
 *   npm run eval -- --case name-only-profile
 *
 * Works through either OpenRouter or the Anthropic API. Set OPENROUTER_API_KEY
 * or ANTHROPIC_API_KEY, in the environment or in a .env at the repository
 * root; if both are present OpenRouter is used unless --provider says
 * otherwise. No Companies House key is needed — no tool is executed. The server is
 * started only to read its real tool definitions and instructions, so what the
 * model sees here is exactly what a host would send it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadEnvFile } from '../src/env-file.js';
import { harnessRoutes } from '../tests/helpers/harness.js';
import type { EvalCase } from './cases.js';
import { CASES } from './cases.js';
import type { ProviderName, Selector, ToolDefinition } from './model.js';
import { createSelector, resolveProvider } from './model.js';
import type { CaseResult } from './score.js';
import { scoreCase, summarise } from './score.js';

const RESULTS_DIR = join(import.meta.dirname, 'results');

interface Options {
  repeat: number;
  provider: ProviderName | undefined;
  model: string | undefined;
  only: string | undefined;
  out: string;
}

function parseArgs(argv: string[]): Options {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const repeat = Number.parseInt(read('--repeat') ?? '1', 10);
  const provider = read('--provider');
  if (provider !== undefined && provider !== 'anthropic' && provider !== 'openrouter') {
    throw new Error(`Unknown --provider "${provider}". Use anthropic or openrouter.`);
  }
  return {
    repeat: Number.isFinite(repeat) && repeat > 0 ? repeat : 1,
    provider: provider as ProviderName | undefined,
    model: read('--model'),
    only: read('--case'),
    out: read('--out') ?? join(RESULTS_DIR, 'latest.json')
  };
}

/**
 * Reads the tool definitions and instructions the server actually publishes.
 *
 * Hand-maintaining a copy of the tool list here would let the eval drift from
 * the server, and an eval that tests a stale tool list is worse than none.
 */
export async function loadServerSurface(): Promise<{ tools: ToolDefinition[]; instructions: string }> {
  const harness = await harnessRoutes([[/.*/, { status: 500 }]]);
  try {
    const { tools } = await harness.client.listTools();
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        input_schema: tool.inputSchema as Record<string, unknown>
      })),
      instructions: harness.client.getInstructions() ?? ''
    };
  } finally {
    await harness.close();
  }
}

export async function runEval(
  selector: Selector,
  cases: EvalCase[],
  repeat: number
): Promise<Map<string, CaseResult[]>> {
  const { tools, instructions } = await loadServerSurface();
  const results = new Map<string, CaseResult[]>();

  for (const testCase of cases) {
    const attempts: CaseResult[] = [];
    for (let index = 0; index < repeat; index += 1) {
      const calls = await selector.select(testCase.question, instructions, tools);
      attempts.push(scoreCase(testCase, calls));
    }
    results.set(testCase.id, attempts);
  }

  return results;
}

function report(cases: EvalCase[], results: Map<string, CaseResult[]>, repeat: number): void {
  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const width = Math.max(...cases.map((testCase) => testCase.id.length));

  process.stdout.write('\nTool selection\n\n');

  for (const [id, attempts] of results) {
    const passes = attempts.filter((attempt) => attempt.passed).length;
    const mark = passes === attempts.length ? 'pass' : passes === 0 ? 'FAIL' : 'FLAKY';
    const tally = repeat > 1 ? ` ${passes}/${repeat}` : '';
    process.stdout.write(`  ${mark.padEnd(5)} ${id.padEnd(width)}${tally}\n`);

    if (passes === attempts.length) continue;

    const failing = attempts.find((attempt) => !attempt.passed);
    for (const check of failing?.checks ?? []) {
      if (check.passed) continue;
      process.stdout.write(`        ${check.name}: ${check.detail}\n`);
    }
    process.stdout.write(`        why this case exists: ${byId.get(id)?.why ?? ''}\n`);
  }

  const summary = summarise(results);
  process.stdout.write(
    `\n  ${summary.passed}/${summary.total} cases passed (${Math.round(summary.passRate * 100)}%)\n`
  );
  if (summary.flaky.length > 0) {
    // Intermittent selection means two descriptions overlap. Reporting it as a
    // pass would hide the ambiguity that caused it.
    process.stdout.write(
      `  ${summary.flaky.length} flaky: ${summary.flaky.join(', ')}\n  Flaky cases mean two tool descriptions overlap. Fix the descriptions, not the case.\n`
    );
  }
}

async function main(): Promise<void> {
  loadEnvFile(join(import.meta.dirname, '..', '.env'));
  const options = parseArgs(process.argv.slice(2));

  const resolution = resolveProvider({ provider: options.provider });
  if (resolution.provider === undefined) {
    process.stderr.write(
      [
        resolution.problem ?? 'No provider available.',
        '',
        'This eval asks a real model which tool it would reach for, so it needs one of:',
        '  OPENROUTER_API_KEY   from openrouter.ai/keys',
        '  ANTHROPIC_API_KEY    from console.anthropic.com',
        '',
        'Put either in your shell or in a .env at the repository root. If both are',
        'set, OpenRouter is used unless --provider says otherwise.',
        '',
        'No Companies House key is required — no tool is executed here, and no',
        'request reaches Companies House.',
        ''
      ].join('\n')
    );
    process.exitCode = 1;
    return;
  }

  const cases = options.only === undefined ? CASES : CASES.filter((entry) => entry.id === options.only);
  if (cases.length === 0) {
    process.stderr.write(`No case matches "${options.only ?? ''}".\n`);
    process.exitCode = 1;
    return;
  }

  const selector = createSelector(resolution.provider, options.model);
  process.stdout.write(`Running ${cases.length} case(s) × ${options.repeat} against ${selector.label}…\n`);

  const results = await runEval(selector, cases, options.repeat);
  report(cases, results, options.repeat);

  const summary = summarise(results);
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    options.out,
    `${JSON.stringify(
      {
        provider: resolution.provider,
        model: selector.label,
        repeat: options.repeat,
        summary,
        cases: [...results].map(([id, attempts]) => ({ id, attempts }))
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  process.stdout.write(`  Written to ${options.out}\n`);

  // A regression in tool selection should fail a pipeline the same way a
  // failing unit test does.
  if (summary.failed > 0 || summary.flaky.length > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  await main();
}
