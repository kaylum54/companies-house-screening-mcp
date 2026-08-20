/**
 * Generates docs/recipes/ — five worked examples, end to end.
 *
 *   npm run docs:generate
 *   npm run docs:check
 *
 * The responses in these pages are **not written by hand**. Each step is run
 * through the real server, over a real MCP client, and whatever comes back is
 * what appears in the page. A recipe that stops working stops generating, and
 * `docs:check` fails the build.
 *
 * The honest caveat, stated in every page: the upstream responses come from
 * the repository's fixtures, which are hand-authored to the documented shape
 * rather than recorded from the live register. So the *shapes*, the *derived
 * fields* and the *behaviour* are real; the companies are invented. Once
 * `npm run record-fixtures` has run against a real key, these pages become
 * real output about real companies with no change to this script.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { harnessRoutes } from '../tests/helpers/harness.js';
import type { FakeResponseSpec } from '../tests/helpers/fake-fetch.js';
import type { GeneratedFile } from './lib/generate.js';
import { apply, GENERATED_BANNER, parseMode, reportAndExit } from './lib/generate.js';

const ROOT = join(import.meta.dirname, '..');
const RECIPES_DIR = join(ROOT, 'docs', 'recipes');

const fixture = (relativePath: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', relativePath), 'utf8')) as unknown;

const PROFILE = fixture('company/profile-active.json');
const DISSOLVED = fixture('company/profile-dissolved.json');
const OFFICERS = fixture('officers/officers-list.json');
const CHARGES = fixture('charges/charges-outstanding.json');
const INSOLVENCY = fixture('insolvency/insolvency-case.json');
const SEARCH = fixture('search/companies.json');
const APPOINTMENTS = fixture('officers/appointments.json');
const FILING_HISTORY = fixture('filing-history/filing-history.json');

type Routes = [RegExp, FakeResponseSpec][];

/**
 * One route table for every recipe, so the invented companies behave the same
 * way on every page.
 *
 * Ordering matters — the specific paths have to come before the general ones,
 * because `/company/00000006` matches the charges URL too. Routing by company
 * number rather than returning one profile for everything is not fussiness: an
 * earlier version of this file returned the same profile regardless, and the
 * generated page showed a name resolving to the wrong company, which is
 * exactly the failure the no-names rule exists to prevent. Documentation that
 * demonstrates the bug you designed against is worse than no documentation.
 *
 * 00000006 — active, trading, two charges of which one is outstanding, no
 * insolvency history (the API answers 404 for that, and the server reads it
 * as "none").
 * SC123456 — dissolved, filings overdue, an insolvency case.
 */
const ROUTES: Routes = [
  [/\/company\/SC123456\/charges/, { body: CHARGES }],
  [/\/company\/SC123456\/insolvency/, { body: INSOLVENCY }],
  [/\/company\/SC123456\/officers/, { body: OFFICERS }],
  [/\/company\/SC123456/, { body: DISSOLVED }],
  [/\/company\/00000006\/charges/, { body: CHARGES }],
  [/\/company\/00000006\/insolvency/, { status: 404 }],
  [/\/company\/00000006\/officers/, { body: OFFICERS }],
  [/\/company\/00000006\/filing-history/, { body: FILING_HISTORY }],
  [/\/company\/00000006/, { body: PROFILE }],
  [/\/officers\/[^/]+\/appointments/, { body: APPOINTMENTS }],
  [/\/search\/companies/, { body: SEARCH }]
];

interface Step {
  /** Prose introducing the call. */
  narrative: string;
  tool: string;
  args: Record<string, unknown>;
  /** Prose after the response. */
  reading?: string;
}

interface Recipe {
  slug: string;
  title: string;
  question: string;
  intro: string;
  steps: Step[];
  closing: string;
}

const RECIPES: Recipe[] = [
  {
    slug: 'supplier-onboarding-check',
    title: 'Screening a list of new suppliers',
    question: 'Thirty names came in from procurement. Which ones need a closer look?',
    intro: `This is the question the server was built for. Paste the list, get one row per company, and spend your attention on the rows that have something on them.

The important behaviour is what happens to the awkward entries. A name matching several companies is never guessed at — it comes back under \`unresolved\` with its candidates so you can ask. Nothing is dropped to make the table tidy.`,
    steps: [
      {
        narrative:
          'Pass the list exactly as it arrived — company numbers, full names and half-remembered names all mixed together.',
        tool: 'screen_companies',
        args: {
          companies: ['00000006', 'Example Fixture Dormant Limited', 'Example Fixture']
        },
        reading: `Read it in three parts.

\`screened\` carries the rows that resolved cleanly, each with its signal codes. \`signal_count\` of zero means nothing on the signal list was found — not that the company is sound.

\`unresolved\` is the one to act on. "Example Fixture" matched several companies and none exactly, so the server stopped and handed back the candidates rather than picking one. Ask procurement which they meant.

\`sections_used\` says what the signals could see. Officers are off by default because they cost an extra request per company; pass \`include_officers: true\` when the question is about who runs these businesses rather than what they owe.`
      }
    ],
    closing: `**If the list is long.** The rate limit is 600 requests per five minutes, and screening costs three per company by default. \`screen_companies\` works out what it can afford, screens that, and returns the rest under \`not_screened\` with the reset time — so a table that comes back short always says why.`
  },

  {
    slug: 'director-conflict-check',
    title: 'Finding an undeclared shared directorship',
    question: 'Does anyone on this board also sit on a company we are already dealing with?',
    intro: `Two calls. List the board, then follow one officer across every company they are appointed to.

The join that makes this work is the officer ID. Companies House never returns it as a field — it exists only inside the appointments URL — so this server digs it out of the link and puts it on every officer. Without that, a board you have just listed is a dead end.`,
    steps: [
      {
        narrative: 'List the board. Resigned officers come back too, which is usually what you want here.',
        tool: 'get_officers',
        args: { company_number: '00000006' },
        reading:
          'Each officer carries an `officer_id`. Service addresses are withheld — they are personal data and are almost never what the question needs. Pass `verbose: true` if you genuinely need them.'
      },
      {
        narrative: 'Take an officer ID and ask what else they run.',
        tool: 'get_officer_appointments',
        args: { officer_id: 'aBcD1234EfGh5678IjKl' },
        reading: `\`active_appointment_count\` is derived from the returned page. Each row carries the company status, so a director with a trail of dissolved companies is visible without a second call per company.

Run this across a whole board and intersect the company numbers against your own customer list. That intersection is the answer to the original question.`
      }
    ],
    closing: `**A caution about identity.** Companies House officer records are per-appointment-identity, not per-person. The same human filed under two spellings of their name has two officer IDs and will not join up here. Date of birth — month and year only — is usually what separates a real match from a coincidence.`
  },

  {
    slug: 'invoice-verification',
    title: 'Checking a new contractor before paying an invoice',
    question: 'This invoice arrived from a company we have never used. Is any of it real?',
    intro: `One call. \`company_snapshot\` fetches the profile, the serving officers, the charges and the insolvency history together and returns them with the signals it found.

The specific things worth checking against the invoice: the company exists, it is active, the registered office matches, and it was not incorporated three weeks ago.`,
    steps: [
      {
        narrative: 'Take the company number from the bottom of the invoice — UK companies are required to print it.',
        tool: 'company_snapshot',
        args: { company_number: '00000006' },
        reading: `\`registered_office_address\` is flattened to one line so it can be compared with what is printed on the invoice without reassembling nine fields.

\`age_years\` and the \`incorporated_within_last_year\` signal are the pair worth reading together on a first invoice from an unknown supplier.

\`sections_included\` says what was actually read. If the charges call had failed, the section would appear under \`sections_unavailable\` instead, and an absent charge signal would mean "not checked" rather than "none".`
      }
    ],
    closing: `**What this cannot tell you.** Whether the company is good for the money. The register shows filings, charges and officers; it does not show the bank balance or the order book. The signals are facts, not a rating, and the judgement stays with you — see [ADR 7](../adr/0007-signals-not-scores.md).`
  },

  {
    slug: 'debtor-risk-screen',
    title: 'Re-checking an aged debtor',
    question: 'This customer has stopped paying. Has something changed on the register?',
    intro: `A company going quiet is often visible on the register before it is visible in your inbox. The pattern to look for is a charge registered recently, accounts going overdue, or an insolvency case appearing.`,
    steps: [
      {
        narrative: 'Snapshot the debtor.',
        tool: 'company_snapshot',
        args: { company_number: 'SC123456' },
        reading: `Several signals at once here, ordered by how much they matter.

\`outstanding_count\` on charges is derived by this server: Companies House reports how many charges have been satisfied and never how many have not, which is the number you actually want. The names in \`holders\` tell you who is ahead of you if it comes to a distribution.

\`floating_charge_over_all_assets\` is worth reading closely on a debtor. It means a lender has security over everything.`
      },
      {
        narrative: 'When there is an insolvency case, pull the detail — the practitioner is who you would need to contact.',
        tool: 'get_insolvency',
        args: { company_number: 'SC123456' },
        reading:
          'Note that a company with no insolvency history returns a not-found error here rather than an empty list. That is a quirk of the API and it means exactly what it sounds like. `company_snapshot` smooths it over; this tool does not.'
      }
    ],
    closing: `**Do not read a signal as a prediction.** Overdue accounts sometimes mean an ill accountant. A company can be perfectly current on filings the month before it collapses. These are the facts on the register, and they are worth a phone call, not a conclusion.`
  },

  {
    slug: 'competitor-filing-watch',
    title: 'Watching a competitor’s filing cadence',
    question: 'When did they last file accounts, and what have they been doing since?',
    intro: `Filing history is the closest thing on the register to a timeline. Accounts tell you the year end and how big the company claims to be; mortgage filings tell you when it borrowed; officer filings tell you when people arrived and left.`,
    steps: [
      {
        narrative: 'Pull the recent history. Filter by category when you only care about one kind of event.',
        tool: 'get_filing_history',
        args: { company_number: '00000006', items_per_page: 5 },
        reading: `\`description\` is a Companies House template key such as \`accounts-with-accounts-type-small\`, with the values that fill it alongside. It is not translated into English here on purpose: rendering it properly needs a template file Companies House ships separately, and a partial local translation would render some filings wrongly with nobody able to tell which.

\`accounts-with-accounts-type-small\` is itself informative — it is the filing of a company below the small-company thresholds.

\`has_document\` says a filed document exists. Fetching the PDF needs the separate Companies House document API, which is out of scope for this server today.`
      }
    ],
    closing: `**For a running watch,** cache TTLs are the thing to know: filing history is cached for six hours, the shortest of any section, because it is what changes when anything happens. Pass \`verbose: true\` or set \`CH_CACHE_ENABLED=false\` if you need this second's answer.`
  }
];

function renderResponse(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function renderCall(step: Step): string {
  return `\`\`\`json\n${JSON.stringify({ tool: step.tool, arguments: step.args }, null, 2)}\n\`\`\``;
}

async function runRecipe(recipe: Recipe): Promise<GeneratedFile> {
  const harness = await harnessRoutes(ROUTES);
  const sections: string[] = [];

  try {
    for (const [index, step] of recipe.steps.entries()) {
      const result = (await harness.client.callTool({
        name: step.tool,
        arguments: step.args
      })) as { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] };

      // A recipe that no longer works must not quietly generate a page that
      // says it does.
      if (result.isError === true) {
        throw new Error(
          `Recipe "${recipe.slug}" step ${index + 1} (${step.tool}) returned an error: ${
            result.content?.[0]?.text ?? 'no content'
          }`
        );
      }

      sections.push(
        [
          `### ${index + 1}. ${step.tool}`,
          '',
          step.narrative,
          '',
          renderCall(step),
          '',
          renderResponse(result.structuredContent),
          '',
          step.reading ?? ''
        ]
          .join('\n')
          .trimEnd()
      );
    }
  } finally {
    await harness.close();
  }

  const contents = `${GENERATED_BANNER}

# ${recipe.title}

> ${recipe.question}

${recipe.intro}

> **About the responses below.** They are real output from this server — every
> call on this page is executed when the documentation is generated, and
> whatever comes back is what you see. The *upstream* data behind them comes
> from the repository's test fixtures, which are hand-authored to the
> documented Companies House shape rather than recorded from the live
> register. So the field names, the derived values and the behaviour are
> genuine; the companies are invented. See
> [tests/fixtures/README.md](../../tests/fixtures/README.md).

## Walkthrough

${sections.join('\n\n')}

## Notes

${recipe.closing}

---

[← All recipes](README.md) · [Tool reference](../tools/README.md)
`;

  return { path: join(RECIPES_DIR, `${recipe.slug}.md`), contents };
}

function renderIndex(): string {
  const rows = RECIPES.map(
    (recipe) => `| [${recipe.title}](${recipe.slug}.md) | ${recipe.question} |`
  ).join('\n');

  return `${GENERATED_BANNER}

# Recipes

Five worked examples. Every call on these pages is executed when the
documentation is generated, so a recipe that stops working stops generating
and CI fails.

| Recipe | The question |
|---|---|
${rows}

The tool-by-tool reference is in [docs/tools](../tools/README.md).
`;
}

export async function generateRecipes(): Promise<GeneratedFile[]> {
  const pages = await Promise.all(RECIPES.map((recipe) => runRecipe(recipe)));
  return [{ path: join(RECIPES_DIR, 'README.md'), contents: renderIndex() }, ...pages];
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const mode = parseMode(process.argv.slice(2));
  const files = await generateRecipes();
  reportAndExit(await apply(files, mode), mode, 'Recipes');
}
