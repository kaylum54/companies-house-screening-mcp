/**
 * Runs the tool-selection eval against a real model.
 *
 *   npm run eval
 *   npm run eval -- --repeat 3
 *   npm run eval -- --provider openrouter --model moonshotai/kimi-k3
 *   npm run eval -- --case number-trap        # a whole category
 *   npm run eval -- --case trap-order-number  # or one case
 *
 * Works through either OpenRouter or the Anthropic API. Set OPENROUTER_API_KEY
 * or ANTHROPIC_API_KEY, in the environment or in a .env at the repository
 * root; if both are present OpenRouter is used unless --provider says
 * otherwise. No Companies House key is needed — no tool is executed. The
 * server is started only to read its real tool definitions and instructions,
 * so what the model sees here is exactly what a host would send it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { loadEnvFile } from '../src/node/env-file.js';
import { harnessRoutes } from '../tests/helpers/harness.js';
import type { EvalCase } from './cases.js';
import { CASES } from './cases.js';
import type { ProviderName, Selector, ToolDefinition } from './model.js';
import { createSelector, resolveProvider } from './model.js';
import type { CaseResult } from './score.js';
import { scoreCase, summarise } from './score.js';

const RESULTS_DIR = join(import.meta.dirname, 'results');
const NL = '\n';

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
  repeat: number,
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, CaseResult[]>> {
  const { tools, instructions } = await loadServerSurface();
  const results = new Map<string, CaseResult[]>();
  const total = cases.length * repeat;
  let done = 0;

  for (const testCase of cases) {
    const attempts: CaseResult[] = [];
    for (let index = 0; index < repeat; index += 1) {
      const calls = await selector.select(testCase.question, instructions, tools);
      attempts.push(scoreCase(testCase, calls));
      done += 1;
      onProgress?.(done, total);
    }
    results.set(testCase.id, attempts);
  }

  return results;
}

const write = (line: string): void => {
  process.stdout.write(line + NL);
};

function report(cases: EvalCase[], results: Map<string, CaseResult[]>, repeat: number): void {
  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const summary = summarise(results);

  // Failures first, then the category breakdown. "Which group is weak" is the
  // question a run exists to answer; a single overall percentage says almost
  // nothing about what to go and fix.
  const failing = [...results].filter(([, attempts]) => !attempts.every((attempt) => attempt.passed));

  if (failing.length === 0) {
    write('');
    write('  No failures.');
  } else {
    write('');
    write(`  ${failing.length} case(s) to look at`);
    write('');
    for (const [id, attempts] of failing) {
      const passes = attempts.filter((attempt) => attempt.passed).length;
      const mark = passes === 0 ? 'FAIL ' : 'FLAKY';
      const tally = repeat > 1 ? ` ${passes}/${repeat}` : '';
      const testCase = byId.get(id);

      write(`  ${mark} ${id}${tally}  [${testCase?.category ?? ''}]`);
      write(`        asked: ${testCase?.question ?? ''}`);

      const failed = attempts.find((attempt) => !attempt.passed);
      for (const check of failed?.checks ?? []) {
        if (check.passed) continue;
        write(`        ${check.name}: ${check.detail}`);
      }
      const chosen = failed?.calls.map((call) => call.name).join(', ');
      write(`        called: ${chosen === undefined || chosen === '' ? '(nothing)' : chosen}`);
      write(`        why the case exists: ${testCase?.why ?? ''}`);
      write('');
    }
  }

  write('');
  write('  By category');
  write('');
  const width = Math.max(...summary.byCategory.map((entry) => entry.category.length));
  for (const entry of summary.byCategory) {
    const flag = entry.passed === entry.total ? '' : '   <--';
    write(`    ${entry.category.padEnd(width)}  ${entry.passed}/${entry.total}${flag}`);
  }

  if (summary.intents.length > 0) {
    write('');
    write('  Paraphrase agreement');
    write('');
    for (const intent of summary.intents) {
      const mark = intent.agreed ? '  ok      ' : '  DIFFERS ';
      write(`  ${mark} ${intent.intent}: ${intent.tools.join(', ')}`);
    }
    if (summary.intents.some((intent) => !intent.agreed)) {
      write('');
      write('    Phrasings of one intent choosing different tools warrants investigation of the');
      write('    descriptions and model behavior — even where each choice is defensible.');
    }
  }

  write('');
  write(`  ${summary.passed}/${summary.total} cases passed (${Math.round(summary.passRate * 100)}%)`);

  if (summary.flaky.length > 0) {
    write(`  ${summary.flaky.length} flaky: ${summary.flaky.join(', ')}`);
    write('  Flaky means inconsistent selections. Investigate descriptions, model variability, provider behavior and case expectations.');
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
      ].join(NL)
    );
    process.exitCode = 1;
    return;
  }

  // --case matches an id or a whole category, so `--case number-trap` runs the
  // group rather than needing six invocations.
  const cases =
    options.only === undefined
      ? CASES
      : CASES.filter((entry) => entry.id === options.only || entry.category === options.only);

  if (cases.length === 0) {
    process.stderr.write(`No case or category matches "${options.only ?? ''}".${NL}`);
    process.exitCode = 1;
    return;
  }

  const selector = createSelector(resolution.provider, options.model);
  write(`Running ${cases.length} case(s) × ${options.repeat} against ${selector.label}…`);

  const startedAt = new Date().toISOString();
  const root = join(import.meta.dirname, '..');
  const git = (args: string[]): string | null => {
    try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
  };
  const sourceHash = createHash('sha256');
  const hashDirectory = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'results' && entry.name !== 'baselines') hashDirectory(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        sourceHash.update(relative(root, path).replaceAll('\\', '/') + '\0');
        sourceHash.update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'));
      }
    }
  };
  hashDirectory(join(root, 'src'));
  hashDirectory(join(root, 'evals'));
  sourceHash.update(readFileSync(join(root, 'package-lock.json')));
  const status = git(['status', '--porcelain']);
  const provenance = {
    startedAt,
    commit: git(['rev-parse', 'HEAD']),
    workingTreeDirty: status === null ? null : status.length > 0,
    sourceSha256: sourceHash.digest('hex'),
    sourceHashScope: 'Sorted src/ and evals/ TypeScript paths and LF-normalized contents (excluding results and baselines), then package-lock.json bytes',
    command: ['npm', 'run', 'eval', '--', '--provider', resolution.provider, '--model', options.model ?? selector.label.replace(/^[^:]+:/, ''), '--repeat', String(options.repeat), ...(options.only === undefined ? [] : ['--case', options.only])]
  };
  const results = await runEval(selector, cases, options.repeat, (done, total) => {
    // A sixty-case run at three repeats is a hundred and eighty requests and
    // several minutes. Silence for that long reads as a hang.
    if (done % 20 === 0 && done !== total) write(`  … ${done}/${total}`);
  });

  report(cases, results, options.repeat);

  const summary = summarise(results);
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(
    options.out,
    JSON.stringify(
      {
        provenance: { ...provenance, completedAt: new Date().toISOString() },
        provider: resolution.provider,
        model: selector.label,
        repeat: options.repeat,
        summary,
        cases: [...results].map(([id, attempts]) => ({
          id,
          category: attempts[0]?.category,
          intent: attempts[0]?.intent,
          question: cases.find((entry) => entry.id === id)?.question,
          attempts
        }))
      },
      null,
      2
    ) + NL,
    'utf8'
  );
  write(`  Written to ${options.out}`);

  // A regression in tool selection should fail a pipeline the same way a
  // failing unit test does.
  if (summary.failed > 0 || summary.flaky.length > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  await main();
}
