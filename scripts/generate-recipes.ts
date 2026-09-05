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
 * The upstream data behind them comes from fixtures recorded from the live
 * Companies House API, so these pages describe real companies.
 *
 * That last fact carries an editorial obligation. The register is public and
 * eligible information is Open Government Licence, but the *narrative* around it would be
 * mine — and "the supplier who cannot be trusted" or "the director who
 * concealed a conflict" is a story about real named people, invented to make a
 * documentation page read well. So the subjects are institutions and
 * widely-reported corporate failures rather than small trading businesses, and
 * the prose describes what the register shows instead of alleging what it
 * means. A shared directorship is a fact; what it implies is not.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadEnvFile } from '../src/node/env-file.js';
import type { FakeResponseSpec } from '../tests/helpers/fake-fetch.js';
import { harnessRoutes } from '../tests/helpers/harness.js';
import type { GeneratedFile } from './lib/generate.js';
import { apply, GENERATED_BANNER, parseMode, reportAndExit } from './lib/generate.js';

const ROOT = join(import.meta.dirname, '..');
const RECIPES_DIR = join(ROOT, 'docs', 'recipes');

const fixture = (relativePath: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', relativePath), 'utf8')) as unknown;

const PROFILE = fixture('company/profile-active.json');
const DISSOLVED = fixture('company/profile-dissolved.json');
const INSOLVENT_PROFILE = fixture('company/profile-insolvent.json');
const OFFICERS = fixture('officers/officers-list.json');
const CHARGES = fixture('charges/charges-outstanding.json');
const INSOLVENCY = fixture('insolvency/insolvency-case.json');
const SEARCH = fixture('search/companies.json');
const APPOINTMENTS = fixture('officers/appointments.json');
const FILING_HISTORY = fixture('filing-history/filing-history.json');

type Routes = [RegExp, FakeResponseSpec][];

/**
 * One route table for every recipe, keyed by company number.
 *
 * Ordering matters — specific paths come before general ones, because
 * `/company/04138203` matches the charges URL too. Routing by number rather
 * than answering every request with the same profile is not fussiness: an
 * earlier version of this file did the latter, and the generated page showed a
 * name resolving to the wrong company — exactly the failure the no-names rule
 * exists to prevent. Documentation that demonstrates the bug you designed
 * against is worse than no documentation.
 *
 * 04138203  Royal Mail Group Limited — active, five officers, fifteen charges
 *           of which two are outstanding, no insolvency (a 404, which the
 *           server reads as "none").
 * 03782379  Carillion PLC — in compulsory liquidation since 2018.
 * 00000006  Marine and General Mutual Life Assurance Society — incorporated
 *           1862, dissolved 2018. The Companies House docs' own example.
 * 14240638  Royal Mail Limited — the exact-match target in a search.
 */
const ROUTES: Routes = [
  [/\/company\/04138203\/charges/, { body: CHARGES }],
  [/\/company\/04138203\/insolvency/, { status: 404 }],
  [/\/company\/04138203\/officers/, { body: OFFICERS }],
  [/\/company\/04138203\/filing-history/, { body: FILING_HISTORY }],
  [/\/company\/04138203/, { body: PROFILE }],
  [/\/company\/03782379\/charges/, { status: 404 }],
  [/\/company\/03782379\/insolvency/, { body: INSOLVENCY }],
  [/\/company\/03782379\/officers/, { status: 404 }],
  [/\/company\/03782379/, { body: INSOLVENT_PROFILE }],
  [/\/company\/00000006\/charges/, { status: 404 }],
  [/\/company\/00000006\/insolvency/, { status: 404 }],
  [/\/company\/00000006/, { body: DISSOLVED }],
  [
    /\/company\/14240638/,
    {
      body: {
        company_number: '14240638',
        company_name: 'ROYAL MAIL LIMITED',
        company_status: 'active',
        type: 'ltd',
        date_of_creation: '2022-07-18'
      }
    }
  ],
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
    title: 'Screening a list of companies',
    question: 'A list of names came in from procurement. Which entries need a closer look?',
    intro: `This is the question the server was built for. Paste the list, get one row per company, and spend your attention on the rows with something on them.

The behaviour worth studying is what happens to the awkward entries. A name matching several companies is never guessed at: it comes back under \`unresolved\` with its candidates so you can ask which was meant. Nothing is dropped to make the table tidy.`,
    steps: [
      {
        narrative:
          'Pass the list exactly as it arrived — company numbers, full names and half-remembered names mixed together.',
        tool: 'screen_companies',
        args: { companies: ['04138203', 'Royal Mail Limited', 'Royal Mail'] },
        reading: `Read it in three parts.

\`screened\` holds the rows that resolved cleanly, each with its signal codes. A \`signal_count\` of zero means nothing on the signal list was found — not that the company is sound.

\`unresolved\` is the row to act on. "Royal Mail" matches thousands of companies and none exactly, so the server stopped and handed back candidates rather than picking one. That refusal is the point: a plausible wrong company number returns a real company that nothing downstream would flag.

\`sections_used\` says what the signals could see. Officers are off by default because they cost an extra request per company; pass \`include_officers: true\` when the question is about who runs these businesses rather than what is registered against them.`
      }
    ],
    closing: `**If the list is long.** The limit is 600 requests per five minutes and screening costs three per company by default. \`screen_companies\` works out what it can afford, screens that, and returns the rest under \`not_screened\` with the reset time — so a table that comes back short always says why.`
  },

  {
    slug: 'director-conflict-check',
    title: 'Mapping an officer across companies',
    question: 'Which other companies is this director appointed to?',
    intro: `Two calls. List the board, then follow one officer across every company they hold an appointment at.

This is a routine due-diligence step: understanding a group structure, a related-party check, or working out whether a name on two contracts is the same person. The register publishes all of it; the tool joins it up.

The join that makes it work is the officer ID. Companies House never returns it as a field — it exists only inside the appointments URL — so this server digs it out of the link and puts it on every officer. Without that, a board you have just listed is a dead end.`,
    steps: [
      {
        narrative: 'List the board. Resigned officers come back too, which is usually what you want here.',
        tool: 'get_officers',
        args: { company_number: '04138203' },
        reading: `Each officer carries an \`officer_id\`. Service addresses are withheld — they are personal data and are rarely what the question needs. Pass \`verbose: true\` if you genuinely need them.

Note \`active_count\` and \`resigned_count\`: they describe the whole register, not the page in front of you. \`pagination.has_more\` says there is more to fetch.`
      },
      {
        narrative: 'Take an officer ID and ask what else they are appointed to.',
        tool: 'get_officer_appointments',
        args: { officer_id: 'gBfDMtBVo3nHfig_wVfjaOA9o1M' },
        reading: `\`active_appointment_count\` is derived from the returned page. Each row carries the company status, so a pattern of dissolved companies would be visible without a second call each. Here the appointments sit across one corporate group, which is what a group directorship looks like on the register.

Run this across a whole board and intersect the company numbers with your own customer or supplier list. That intersection is the answer.`
      }
    ],
    closing: `**A caution about identity.** Companies House officer records are per-appointment-identity, not per-person. The same human filed under two spellings has two officer IDs and will not join up here, and two different people sharing a name will not be told apart by name alone. Date of birth — month and year only — is usually what distinguishes them.

**And about inference.** A shared directorship is a fact. What it means is not: group structures, professional non-executive directors and common company-secretarial providers all produce overlaps of no significance whatsoever.`
  },

  {
    slug: 'invoice-verification',
    title: 'Verifying a company on an invoice',
    question: 'Do the invoice company details match the registered entity?',
    intro: `One call. \`company_snapshot\` fetches the profile, the serving officers, the charges and the insolvency history together, and returns them with the signals it found.

Compare the company number, legal name and registered office with the invoice. Read the registered status and incorporation date as context. Active status does not prove current trading, an authentic invoice or ownership of a bank account. A trading address can legitimately differ from the registered office.`,
    steps: [
      {
        narrative:
          'Use the company number supplied on the invoice. If absent, resolve the legal entity with find_company and confirm the candidate before continuing.',
        tool: 'company_snapshot',
        args: { company_number: '04138203' },
        reading: `\`registered_office_address\` is flattened to one line so it can be compared with what is printed, without reassembling nine fields.

\`age_years\` and the \`incorporated_within_last_year\` signal are the pair to read together on a first invoice from an unfamiliar supplier.

\`sections_included\` says what was actually read. Insolvency appears there even though this company has none: Companies House answers 404 for a company with no insolvency case, and the server reads that as "none" rather than as a fault. Had the call genuinely failed, the section would appear under \`sections_unavailable\` instead — and an absent signal would then mean "not checked" rather than "nothing found".`
      }
    ],
    closing: `**What this cannot tell you.** Whether the invoice is authentic, the bank account belongs to the company, the company is currently trading, or it is good for the money. Verify bank-detail changes through an independently established contact channel. The register shows filings, charges and officers; it does not show the bank balance or the order book. The signals are facts, not a rating, and the judgement stays with you — see [ADR 7](../adr/0007-signals-not-scores.md).

**Coverage.** The officer list is one page: read officers.pagination.has_more and use get_officers to continue. Global officer counts can exceed the active entries shown here. Check meta.age_seconds and meta.stale before relying on cached information.

**One caveat found in real data.** The profile's own \`has_charges\` flag reported false for this company while its charges endpoint returned fifteen. The charges section is authoritative; the flag is not, and no signal is derived from it.`
  },

  {
    slug: 'debtor-risk-screen',
    title: 'What insolvency looks like on the register',
    question: 'A company has entered an insolvency process. What does the register show?',
    intro: `When a company fails, the register records it: the status changes, filings fall overdue, and an insolvency case appears with the practitioner appointed to it. Knowing the shape of that record is what lets you recognise it early elsewhere.

The example is Carillion, whose 2018 compulsory liquidation is among the most publicly documented corporate failures in the UK. Nothing on this page is news about it.`,
    steps: [
      {
        narrative: 'Snapshot the company.',
        tool: 'company_snapshot',
        args: { company_number: '03782379' },
        reading: `Several signals at once, ordered by how much they matter. \`insolvency_proceedings\` comes from the company status; \`insolvency_history\` and \`accounts_overdue\` come from the profile.

Note what the ordering is *not*: nothing here combines signals into a score. A company with three signals is not "worse" than one with two by any arithmetic this server performs, and it declines to pretend otherwise.

Look at \`sections_unavailable\` too. The officers call failed here, so that section is named as unread and is absent from \`sections_included\` — which means the officer-based signals are *unknown* rather than *clear*. That distinction is the whole reason both fields exist.`
      },
      {
        narrative: 'Pull the insolvency detail — the practitioner is who a creditor would need to contact.',
        tool: 'get_insolvency',
        args: { company_number: '03782379' },
        reading: `A company with no insolvency history returns a not-found error from this tool rather than an empty list. That is a quirk of the API and it means exactly what it sounds like; \`company_snapshot\` smooths it over, this tool does not.`
      }
    ],
    closing: `**Do not read a signal as a prediction.** Overdue accounts often mean an ill accountant rather than a failing business, and a company can be perfectly current on its filings the month before it collapses. These are facts on a public register, worth a phone call rather than a conclusion.`
  },

  {
    slug: 'competitor-filing-watch',
    title: 'Reading a filing cadence',
    question: 'When did they last file accounts, and what has been filed since?',
    intro: `Filing history is the closest thing on the register to a timeline. Accounts give the year end and the size bracket a company files under; mortgage filings show when it borrowed; officer filings show when people arrived and left.`,
    steps: [
      {
        narrative: 'Pull the recent history. Filter by category when only one kind of event matters.',
        tool: 'get_filing_history',
        args: { company_number: '04138203', items_per_page: 5 },
        reading: `\`description\` is a Companies House template key such as \`accounts-with-accounts-type-full\`, with the values that fill it alongside. It is not translated into English here on purpose: rendering it properly needs a template file Companies House ships separately, and a partial local translation would render some filings wrongly with nobody able to tell which.

The key is informative in itself — \`accounts-type-full\` is a company filing full accounts rather than the abridged or micro-entity form.

\`has_document\` says a filed document exists. Fetching the PDF needs the separate Companies House document API, which is out of scope for this server today.`
      }
    ],
    closing: `**For a running watch,** the cache TTLs are what to know: filing history is cached for six hours, the shortest of any section, because it is what changes when anything happens. Set \`CH_CACHE_ENABLED=false\` if you need this second's answer.`
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
> whatever comes back is what you see. The upstream data comes from fixtures
> recorded from the live Companies House API, so the companies are real and
> the facts are public record. Open Government Licence v3.0 applies to eligible information,
> excluding personal data and other OGL exceptions. The framing around them is illustrative: this project makes no claim
> about any company or person named here beyond what the register itself
> states.

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

The companies shown are real and the data is public record. Open Government Licence v3.0 applies
to eligible information; personal data and other OGL exceptions are excluded. Nothing here asserts anything about them beyond what
the register states.

The tool-by-tool reference is in [docs/tools](../tools/README.md).
`;
}

export async function generateRecipes(): Promise<GeneratedFile[]> {
  loadEnvFile(join(ROOT, '.env'));
  const pages = await Promise.all(RECIPES.map((recipe) => runRecipe(recipe)));
  return [{ path: join(RECIPES_DIR, 'README.md'), contents: renderIndex() }, ...pages];
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const mode = parseMode(process.argv.slice(2));
  const files = await generateRecipes();
  reportAndExit(await apply(files, mode), mode, 'Recipes');
}
