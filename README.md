# companies-house-screening-mcp

Turn a list of UK companies into a register-checking worksheet in your AI assistant: registered details, filing observations, charges, and entries that need human follow-up.

[![npm](https://img.shields.io/npm/v/companies-house-screening-mcp)](https://www.npmjs.com/package/companies-house-screening-mcp)
[![CI](https://github.com/kaylum54/companies-house-screening-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/kaylum54/companies-house-screening-mcp/actions/workflows/ci.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

Free, MIT-licensed source. Read-only access to Companies House. Your AI client may have its own account requirements or charges.

## Try a business workflow

Paste this into your assistant after connecting the server:

> Screen companies 04138203 and 00000006. Return one row per input with legal name, registered status, factual signals, sections checked, missing sections and data freshness. Keep unresolved and not-screened entries visible. Do not assign a risk score or call any company safe. Explain which records need human follow-up and why.

The server returns structured facts; your assistant formats the worksheet. The [executed supplier example](docs/recipes/supplier-onboarding-check.md) shows the actual response from recorded public-register fixtures. Its data is a dated example, not a current assessment of those companies.

[First-video setup and script](docs/tiktok-01-supplier-screening.md) · [Sample list](examples/supplier-list.csv) · [Business prompts and filming scripts](docs/business-demos.md) · [Setup walkthrough](docs/getting-started.md)

Two more prompts:

> Check company 04138203 against the legal name and registered-office address I supply from an invoice. Show matches, differences and unknowns. Do not treat a match as proof that the invoice or bank details are authentic.

> Get the filing history for company 04138203. Summarise filings since the date I give you, fetching further pages as needed. Distinguish filing dates from the period covered. Do not claim to have read the filed documents.

## Connect

**There is no public endpoint advertised by this project.** Use a local server with your own free Companies House API key, or connect to an instance you or your organisation operates. A placeholder URL is not a working service.

### Local: your own key, no hosting

1. Install **Node.js 22 or newer** and an MCP client that supports local stdio servers.
2. Register at the [Companies House developer portal](https://developer.company-information.service.gov.uk/), create a Live application and a REST API key.
3. Add this configuration to your client's MCP server settings, replace the key, and restart or reconnect the client:

```json
{
  "mcpServers": {
    "companies-house": {
      "command": "npx",
      "args": ["-y", "companies-house-screening-mcp@latest"],
      "env": { "COMPANIES_HOUSE_API_KEY": "your_key" }
    }
  }
}
```

On Windows, some clients require `npx.cmd` as the command. See [setup and troubleshooting](docs/getting-started.md) for client configuration, success checks, Docker and Windows details. Keep keys out of screenshots and source control.

### Hosted: an operator supplies a URL

An operator can deploy to Cloudflare Workers or a single Node host using [the deployment guide](docs/deployment.md). Users then connect to its actual HTTPS MCP URL. For example, in Claude Code:

```bash
claude mcp add --transport http companies-house https://YOUR-HOST/mcp
```

The shared key has a finite budget; a public service is not unlimited. [Rate limits](docs/rate-limits.md) explains fair shares, partial batches and bring-your-own-key support. Read [operating a public deployment](docs/deployment.md#before-you-make-it-public) before sharing an endpoint. This repository does not promise hosted availability or free hosting.

## Read results correctly

- Signals are observations, not a credit rating, fraud verdict or onboarding approval.
- Registered status `active` does not establish current trading, solvency, invoice authenticity or bank-account ownership.
- An empty signal list is not a clean bill of health. Check each row's `sections_included`, `sections_unavailable` and `meta`.
- Snapshots fetch one officer page. `officers.pagination` describes that page before filtering to active entries; counts describe the whole register. Use `get_officers` pagination for the remaining records. Screening exposes `officers_pagination` when requested.
- Outstanding and partially satisfied charges are separate observations. Registration does not reveal the current debt balance; satisfaction records can lag repayment.
- Check `meta.age_seconds` and `meta.stale`. Profiles, charges and insolvency have a 24-hour cache TTL by default. A hosted caller cannot force a refresh through a tool argument; the operator can disable caching.
- Company names can be ambiguous. Confirm the intended legal entity. Number validation rejects names but cannot detect every plausible company number invented by an AI.
- This covers entities on the UK register, not every UK business. No result for a sole trader is not evidence of wrongdoing.
- Filing history describes filings. This server does not download or analyse account PDFs, submit filings, or schedule company watches.

## Tools

| Tool | Purpose |
|---|---|
| `find_company` | Find candidates and resolve a name to a company number. |
| `find_officer` | Search officer identities; a shared name alone does not prove identity. |
| `get_company` | Registered profile and filing due dates. |
| `get_officers` | Paginated current and resigned officer records. |
| `get_filing_history` | Paginated filing metadata, filterable by category. |
| `get_charges` | Registered security, holders and satisfaction categories. |
| `get_psc` | Registered persons with significant control. |
| `get_insolvency` | Recorded insolvency cases and practitioners. |
| `get_officer_appointments` | Paginated appointments associated with an officer ID. |
| `company_snapshot` | Profile, officer page, charges and insolvency with factual signals. |
| `screen_companies` | Up to 50 names or numbers, with coverage and unresolved/skipped entries. |

[Generated tool reference](docs/tools/README.md) · [Executed recipes](docs/recipes/README.md) · [MCP capabilities](docs/mcp-surface.md)

## Engineering and evidence

The client handles timeouts, retryable failures, caching and request budgets. Projections simplify upstream responses; deterministic rules derive signals. Composite tools fetch the profile first, avoiding extra requests for an invalid company, then fetch the other sections concurrently.

The tradeoff is explicit: an officer summary costs one upstream request, while full officer coverage requires pagination. The output exposes that boundary instead of implying the summary is exhaustive.

Tool references are generated from a running MCP server and recipes execute against recorded fixtures. CI checks those generated files for drift. Handwritten guidance and external service details still require review.

Node tests cover the domain, transports and failure handling; Workers tests execute inside workerd. CI runs Node checks on Linux and Windows. Release workflows verify the package and publish npm/container provenance. [Architecture decisions](docs/adr) document the choices, including [partial results](docs/adr/0008-partial-results-and-budget-honesty.md) and [runtime portability](docs/adr/0014-runtime-portable-core.md).

The [tool-selection eval](evals/README.md) measures first-call choice, arguments and grounding across 58 cases. It does not establish the accuracy of a complete business report. Historical measurements and their provenance limitations are documented there; new runs record source and execution metadata.

## Related project

[companies-house-mcp by aicayzer](https://github.com/aicayzer/companies-house-mcp) is an alternative worth evaluating, particularly for broader API or document access. Check its current documentation for capabilities. This project's focus is batch screening, composite summaries, explicit coverage and tool-selection evaluation.

## Configuration

Only one variable is required.

| Variable | Default | Notes |
|---|---|---|
| `COMPANIES_HOUSE_API_KEY` | — | Required. Create a REST API key at the [developer portal](https://developer.company-information.service.gov.uk/). Not a streaming key. |
| `CH_API_BASE_URL` | `https://api.company-information.service.gov.uk` | Override for a proxy. |
| `CH_RATE_LIMIT` | `600` | Requests per window. Lower it if the key is shared with another process. |
| `CH_RATE_WINDOW_MS` | `300000` | Five minutes. |
| `CH_RATE_SAFETY_MARGIN` | `0.95` | Fraction of the budget this process will use. |
| `CH_CACHE_ENABLED` | `true` | |
| `CH_CACHE_DIR` | platform cache dir | Respects `XDG_CACHE_HOME` and `LOCALAPPDATA`. |
| `CH_TIMEOUT_MS` | `10000` | Per request. |
| `CH_MAX_RETRIES` | `3` | Retries after the first attempt. |
| `CH_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. Logs go to stderr. |
| `CH_ENV_FILE` | — | Absolute path to a `.env` for the server to read. Not set by default, deliberately. |


## Development and verification

```bash
npm ci
npm run typecheck
npm run build
npm run docs:check
npm run test:coverage
npm run test:workers
npm run release:check
```

Build before tests so the compiled stdio entry-point tests run. No API key is required for the offline suites. After changing tool schemas or recipe prose in `scripts/generate-recipes.ts`, run `npm run docs:generate` and commit the generated changes.

For live validation, copy `.env.example` to `.env`, supply a Companies House REST key and run `npm run test:live`. Scheduled CI runs this only when its secret is configured. Model evaluations require a separately billed provider key; see [eval instructions](evals/README.md).

The published server does not automatically read a working-directory `.env`. Set `CH_ENV_FILE` to an absolute path if needed. [Fixture recording](tests/fixtures/README.md) and [observability](docs/observability.md) cover maintenance.

## Licence and data reuse

Source code: [MIT](LICENSE), including commercial use subject to its notice requirements.

Companies House data is separate from the source-code licence. The [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) applies to eligible public-sector information, subject to its exclusions. **Personal data is excluded from OGL licensing**; public availability does not remove applicable data-protection duties. See [the National Archives' exceptions](https://www.nationalarchives.gov.uk/information-management/re-using-public-sector-information/uk-government-licensing-framework/open-government-licence/exceptions-to-ogl/).

When reusing OGL-covered information, include:

> Contains public sector information licensed under the Open Government Licence v3.0.

The response label `OGL-v3.0` does not grant blanket reuse rights over every returned field. This project is not affiliated with or endorsed by Companies House.
