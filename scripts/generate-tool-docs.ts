/**
 * Generates the tool reference in docs/tools/ from the running server.
 *
 *   npm run docs:generate      # rewrite the files
 *   npm run docs:check         # fail if what is committed differs
 *
 * The source is the server itself, inspected over a real MCP client, rather
 * than the Zod schemas directly. That matters: what gets documented is what a
 * host is actually told, after the SDK has converted the schemas to JSON
 * Schema. Documenting the input and discovering later that the output differs
 * is precisely the drift this is meant to prevent.
 *
 * The harness is imported from the test helpers. Both are development-only —
 * neither ships in the package — and one implementation that both use cannot
 * disagree with itself, which two would eventually do.
 */

import { join } from 'node:path';

import { harnessRoutes } from '../tests/helpers/harness.js';
import type { GeneratedFile } from './lib/generate.js';
import { apply, GENERATED_BANNER, parseMode, reportAndExit } from './lib/generate.js';
import { rowsToTable, schemaToRows } from './lib/schema-table.js';

const DOCS_DIR = join(import.meta.dirname, '..', 'docs', 'tools');

interface ToolInfo {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } | undefined;
}

/** One-line summaries for the index. Kept short; the page carries the detail. */
const SUMMARIES: Record<string, string> = {
  find_company: 'Search for a company by name or number.',
  find_officer: 'Search for a company officer by name.',
  get_company: 'Registered profile for one company, with derived flags.',
  get_officers: 'Directors, secretaries and members, current and resigned.',
  get_filing_history: 'What a company has filed, and when.',
  get_charges: 'Secured debt registered against a company.',
  get_psc: 'Who controls the company, and how.',
  get_insolvency: 'Insolvency cases and the practitioners appointed.',
  get_officer_appointments: 'Every company an officer sits on.',
  company_snapshot: 'Profile, officers, charges and insolvency in one call.',
  screen_companies: 'Screen a list of up to 50 companies.'
};

function renderTool(tool: ToolInfo): string {
  const inputRows = schemaToRows(tool.inputSchema);
  const outputRows = schemaToRows(tool.outputSchema);

  const annotations: string[] = [];
  if (tool.annotations?.readOnlyHint === true) {
    annotations.push('reads only and changes nothing');
  }
  if (tool.annotations?.openWorldHint === true) {
    annotations.push('calls an external service (the Companies House API)');
  }

  return `${GENERATED_BANNER}

# \`${tool.name}\`

${tool.title === undefined ? '' : `**${tool.title}**\n`}
${tool.description ?? ''}

${annotations.length === 0 ? '' : `This tool ${annotations.join(', and ')}.\n`}
## Input

${rowsToTable(inputRows, 'This tool takes no arguments.')}
## Output

${rowsToTable(outputRows, 'This tool returns no structured output.')}
On failure the tool returns \`isError: true\` and a payload carrying \`code\`,
\`message\`, \`next_step\` and \`retryable\` instead of the fields above. See
[the error reference](README.md#errors).

---

[← All tools](README.md)
`;
}

function renderIndex(tools: ToolInfo[]): string {
  const rows = tools
    .map((tool) => `| [\`${tool.name}\`](${tool.name}.md) | ${SUMMARIES[tool.name] ?? ''} |`)
    .join('\n');

  return `${GENERATED_BANNER}

# Tool reference

Eleven tools, all read-only. Start with \`company_snapshot\` for one company
and \`screen_companies\` for a list; reach for the primitives when you need a
full list rather than a summary.

| Tool | Does |
|---|---|
${rows}

## The common envelope

Every tool returns a \`meta\` block:

| Field | Meaning |
|---|---|
| \`cached\` | Served from the local cache rather than a live request. |
| \`stale\` | Served from an expired cache entry because Companies House was unreachable. Treat the data as possibly out of date. |
| \`age_seconds\` | How old a cached answer is. Absent for a live answer. |
| \`rate_limit_remaining\` | Requests left in the current five-minute window. Pace long runs by this. |
| \`rate_limit_resets_in_ms\` | Milliseconds until more budget is available. |
| \`licence\` | Always \`OGL-v3.0\`. |

Every tool except \`screen_companies\` accepts \`verbose\`, which adds the
untouched Companies House payload under \`raw\` alongside the shaped result.
It is roughly two and a half times the size, so reach for it only when a field
you need is missing from the shaped output.

## Company numbers

Retrieval tools take an eight-character company number and **refuse a company
name**. Leading zeros may be omitted — \`1234567\` and \`01234567\` are the same
company. Anything containing three or more consecutive letters is rejected
before a request is made, with an error naming \`find_company\`.

The reason is in [ADR 5](../adr/0005-question-shaped-tool-surface.md): given a
name, a model produces a company number that looks right, and a plausible
wrong company number returns a *different real company* — real directors, real
charges — that nothing downstream marks as wrong.

## Errors

A failed tool call returns \`isError: true\` and this payload:

| Field | Meaning |
|---|---|
| \`code\` | Stable, safe to branch on. |
| \`message\` | One plain sentence. No stack trace. |
| \`next_step\` | What to do instead, as an instruction. |
| \`status\` | The upstream HTTP status, where there was one. |
| \`retry_after_ms\` | Present on \`RATE_LIMITED\`. |
| \`retryable\` | Whether retrying the identical call could succeed. |

| Code | Means | Retryable |
|---|---|---|
| \`INVALID_COMPANY_NUMBER\` | Malformed number, or a name was passed where a number belongs. | no |
| \`RESOURCE_NOT_FOUND\` | No such company — or the company exists with nothing filed under this section. | no |
| \`AUTH_INVALID\` | The API key is missing, mistyped or revoked. A configuration problem. | no |
| \`AUTH_FORBIDDEN\` | The key is valid but not permitted to read this resource. | no |
| \`RATE_LIMITED\` | 600 requests per five minutes reached. | yes |
| \`UPSTREAM_UNAVAILABLE\` | Companies House returned 5xx. | yes |
| \`UPSTREAM_TIMEOUT\` | No response inside the timeout. | yes |
| \`UPSTREAM_MALFORMED\` | A response that would not parse as JSON, usually an HTML error page. | yes |
| \`UPSTREAM_BAD_REQUEST\` | Companies House rejected the request. | no |
| \`NETWORK_ERROR\` | Could not reach Companies House at all. | yes |

## Signals

\`company_snapshot\` and \`screen_companies\` return signals: facts read off the
register, each with the date or name behind it. **There is no score, grade or
traffic light, and there will not be one** — see
[ADR 7](../adr/0007-signals-not-scores.md). An empty signal list means nothing
on the list was found, not that the company is sound, and signals can only
reflect the sections named in \`sections_included\`.
`;
}

export async function generateToolDocs(): Promise<GeneratedFile[]> {
  // Every request would be a defect here — the generator inspects the server,
  // it does not exercise it.
  const harness = await harnessRoutes([[/.*/, { status: 500 }]]);
  try {
    const { tools } = await harness.client.listTools();
    const sorted = [...(tools as ToolInfo[])].sort((a, b) => a.name.localeCompare(b.name));

    return [
      { path: join(DOCS_DIR, 'README.md'), contents: renderIndex(sorted) },
      ...sorted.map((tool) => ({
        path: join(DOCS_DIR, `${tool.name}.md`),
        contents: renderTool(tool)
      }))
    ];
  } finally {
    await harness.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const mode = parseMode(process.argv.slice(2));
  const files = await generateToolDocs();
  reportAndExit(await apply(files, mode), mode, 'Tool reference');
}
