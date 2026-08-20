/**
 * Renders a comparison table from several eval result files.
 *
 *   npx tsx scripts/compare-evals.ts evals/results/*.json
 *
 * Deliberately not part of `docs:generate`. That pipeline regenerates from the
 * running server and is gated in CI; this needs API keys and costs money, so
 * it cannot be regenerated on demand and must not be something CI expects to
 * reproduce. The output is pasted into the docs as a dated snapshot, which is
 * the honest treatment of a measurement that cannot be re-run for free.
 */

import { readFileSync } from 'node:fs';

interface Attempt {
  passed: boolean;
  chosenTool?: string;
}

interface CaseRecord {
  id: string;
  category?: string;
  intent?: string;
  attempts: Attempt[];
}

interface ResultFile {
  provider: string;
  model: string;
  repeat: number;
  summary: {
    total: number;
    passed: number;
    passRate: number;
    flaky: string[];
    byCategory: { category: string; passed: number; total: number }[];
    intents: { intent: string; tools: string[]; agreed: boolean }[];
  };
  cases: CaseRecord[];
}

function load(path: string): ResultFile {
  return JSON.parse(readFileSync(path, 'utf8')) as ResultFile;
}

/** Strips the provider prefix so the column heading stays readable. */
const shortModel = (model: string): string => model.replace(/^[a-z]+:/, '');

function main(): void {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    process.stderr.write('Usage: tsx scripts/compare-evals.ts <result.json> [...]\n');
    process.exitCode = 1;
    return;
  }

  const runs = paths.map(load);
  const write = (line = ''): void => {
    process.stdout.write(line + '\n');
  };

  const header = ['Category', ...runs.map((run) => shortModel(run.model))];
  const categories = [...new Set(runs.flatMap((run) => run.summary.byCategory.map((c) => c.category)))].sort();

  write(`| ${header.join(' | ')} |`);
  write(`|${header.map(() => '---').join('|')}|`);

  for (const category of categories) {
    const cells = runs.map((run) => {
      const entry = run.summary.byCategory.find((c) => c.category === category);
      if (entry === undefined) return '—';
      const mark = entry.passed === entry.total ? '' : ' ⚠';
      return `${entry.passed}/${entry.total}${mark}`;
    });
    write(`| \`${category}\` | ${cells.join(' | ')} |`);
  }

  const totals = runs.map(
    (run) => `**${run.summary.passed}/${run.summary.total}** (${Math.round(run.summary.passRate * 100)}%)`
  );
  write(`| **Total** | ${totals.join(' | ')} |`);

  const flakes = runs.map((run) => (run.summary.flaky.length === 0 ? 'none' : String(run.summary.flaky.length)));
  write(`| Flaky cases | ${flakes.join(' | ')} |`);

  const disagreements = runs.map((run) => {
    const differing = run.summary.intents.filter((intent) => !intent.agreed).length;
    return differing === 0 ? 'none' : `${differing} of ${run.summary.intents.length}`;
  });
  write(`| Paraphrase sets disagreeing | ${disagreements.join(' | ')} |`);

  // A case only one model fails is a fact about that model. A case they all
  // fail is a fact about the tool description, and that is the useful half.
  write();
  write('### Where they differ');
  write();

  const ids = [...new Set(runs.flatMap((run) => run.cases.map((entry) => entry.id)))];
  const rows: string[] = [];

  for (const id of ids) {
    const outcomes = runs.map((run) => {
      const record = run.cases.find((entry) => entry.id === id);
      if (record === undefined) return undefined;
      const passes = record.attempts.filter((attempt) => attempt.passed).length;
      return { passes, of: record.attempts.length, record };
    });

    if (outcomes.every((outcome) => outcome !== undefined && outcome.passes === outcome.of)) continue;

    const cells = outcomes.map((outcome) => {
      if (outcome === undefined) return '—';
      if (outcome.passes === outcome.of) return 'pass';
      const tools = [...new Set(outcome.record.attempts.map((a) => a.chosenTool ?? '(none)'))];
      return `${outcome.passes}/${outcome.of} — chose ${tools.join(', ')}`;
    });

    const category = outcomes.find((outcome) => outcome !== undefined)?.record.category ?? '';
    rows.push(`| \`${id}\` | ${category} | ${cells.join(' | ')} |`);
  }

  if (rows.length === 0) {
    write('Every model passed every case.');
  } else {
    write(`| Case | Category | ${runs.map((run) => shortModel(run.model)).join(' | ')} |`);
    write(`|---|---|${runs.map(() => '---').join('|')}|`);
    for (const row of rows) write(row);
  }
}

main();
