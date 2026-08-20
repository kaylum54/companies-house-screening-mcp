# companies-house-mcp

An MCP server for the UK [Companies House public data API](https://developer.company-information.service.gov.uk/).
Read-only, rate-limit aware, and designed around the questions people ask
rather than the endpoints the API happens to expose.

> **Status: phase 4 of 6.** All eleven tools work, the reference is generated
> from the running server, and the five worked examples execute on every build.
> Usable from a host today with an API key. Not yet published to npm — the
> tool-selection eval suite and the release pipeline are phases 5 and 6.

## Why another API wrapper

The obvious way to build this is one MCP tool per endpoint. Twenty-two thin
pass-throughs, a weekend's work, and it is what most published MCP servers
are. It is also bad in three specific ways:

- Every tool schema sits in the model's context on every turn, whether the
  task needs it or not.
- It pushes the orchestration onto the model. "Is this supplier safe to
  onboard" becomes search, then profile, then officers, then charges, then
  insolvency — five round trips and five chances to lose the thread.
- Companies House payloads carry structure no model reads — `links`, `etag`,
  `kind`, nine-key address objects. Shaping them away saves between 29% and
  42% depending on the endpoint, measured rather than assumed
  (`npx tsx scripts/measure-projections.ts`).

So this server exposes eleven tools shaped around questions, two of which
(`company_snapshot` and `screen_companies`) do the fan-out server-side and
return one derived object. Retrieval tools accept a company number and refuse
a company name, because given a name a model will guess a number, and a
plausible wrong company number returns a real company that nothing downstream
flags as wrong.

## The tools

| Tool | Returns |
|---|---|
| `find_company` | Ranked candidates for a name or number, with a `disambiguation_needed` flag. |
| `find_officer` | Candidate officer IDs for a person's name, with appointment counts. |
| `get_company` | Profile, plus derived flags for overdue filings, charges, insolvency and recent incorporation. |
| `get_officers` | Current and resigned officers, each with the ID needed to look up their other companies. |
| `get_filing_history` | What was filed and when, filterable by category. |
| `get_charges` | Secured debt, with a derived `outstanding_count` the API never reports. |
| `get_psc` | Who actually controls the company, and how that control is held. |
| `get_insolvency` | Insolvency cases and the practitioners appointed. |
| `get_officer_appointments` | Every company an officer sits on — the conflict-of-interest tool. |
| `company_snapshot` | Profile, officers, charges and insolvency in one call, with signals. |
| `screen_companies` | Up to 50 companies in, one row each out, nothing dropped quietly. |

Full reference: [docs/tools](docs/tools/README.md). Worked examples:
[docs/recipes](docs/recipes/README.md) — supplier screening, director conflict
checks, invoice verification, debtor risk, competitor filing watch.

**The signals are facts, not a rating.** This server does not score companies
and will not tell you whether one is safe to trade with — it reports what it
found on the register, with the date or the name behind each observation, and
leaves the judgement with the person who has the context. An empty signal list
means nothing on the list was found, not that the company is sound.
[ADR 7](docs/adr/0007-signals-not-scores.md) has the full reasoning.

Every tool is annotated `readOnlyHint: true`, publishes an output schema, and
takes `verbose` to return the untouched payload alongside the shaped one.

## Under the tools

| Piece | What it does |
|---|---|
| `loadConfig` | Validates every environment variable at startup and reports all the problems at once, naming the variable rather than the internal field. |
| `CompaniesHouseClient` | Basic-auth requests, per-request timeout, jittered retry on 429 and 5xx, conditional revalidation, stale-on-failure fallback. |
| `RateLimiter` | Sliding window sized to the documented 600 per five minutes, with a safety margin and serialised acquisition. |
| `ResponseCache` | Memory over disk, TTL per resource kind, atomic writes, corrupt entries treated as a miss. |
| `CompaniesHouseError` | Every failure carries a stable code, a plain sentence and a next step. |
| Projections | Upstream read defensively field by field; output validated strictly against the published schema. |

223 tests, no network, no API key required to run them.

## Running it from a host

```json
{
  "mcpServers": {
    "companies-house": {
      "command": "node",
      "args": ["/absolute/path/to/companies-house-mcp/dist/bin.js"],
      "env": { "COMPANIES_HOUSE_API_KEY": "your_key" }
    }
  }
}
```

Once it is published to npm this becomes `npx -y companies-house-mcp`.

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

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm run docs:generate
```

**The documentation is generated and gated.** `docs/tools` is rendered from the
running server over a real MCP client, and every call in `docs/recipes` is
executed when the pages are built. `npm run docs:check` fails if what is
committed differs, CI runs it before the tests, and the suite runs the same
comparison so the failure arrives while you still have the change in front of
you. Change a tool description and you regenerate, or the build goes red.

The suite runs offline against recorded fixtures, so a fresh clone works with
nothing configured. Fixtures are currently hand-authored to the documented
shape — see [tests/fixtures/README.md](tests/fixtures/README.md) for what that
means and how to replace them with real recordings.

Once you hold a key:

```bash
COMPANIES_HOUSE_API_KEY=your_key npm run test:live
```

That test runs nightly in CI. Its job is not to pass — it is to fail loudly the
week Companies House changes a field, so the fixtures get refreshed before a
user finds the drift instead.

## Design notes

Nine decisions are written up in [docs/adr](docs/adr):

1. [Recording architecture decisions](docs/adr/0001-record-architecture-decisions.md)
2. [The sliding-window rate limiter and its safety margin](docs/adr/0002-sliding-window-rate-limiter.md)
3. [Errors as data rather than exceptions](docs/adr/0003-errors-are-data.md)
4. [Caching, TTLs and the stale fallback](docs/adr/0004-caching-and-stale-fallback.md)
5. [Question-shaped tools, and why a name is refused](docs/adr/0005-question-shaped-tool-surface.md)
6. [Why the result payload is sent twice](docs/adr/0006-duplicated-result-payload.md)
7. [Signals, not scores](docs/adr/0007-signals-not-scores.md)
8. [Partial results, and never dropping anything quietly](docs/adr/0008-partial-results-and-budget-honesty.md)
9. [Generated documentation, gated in CI](docs/adr/0009-documentation-is-generated-and-gated.md)

## Scope

Read-only, permanently. Every tool is annotated `readOnlyHint: true` and there
is no write path. The Companies House *filing* API, which submits documents on
a company's behalf, is a different product with a different risk profile and is
out of scope for this one. The streaming API is out of scope too. Fetching the
PDF or iXBRL of a filing through the document API is phase 7 and would remain
read-only.

## Roadmap

| Phase | Content | Status |
|---|---|---|
| 1 | Client, auth, rate limiter, cache, error mapping, fixtures | done |
| 2 | Nine primitive tools with Zod schemas and shaped projections | done |
| 3 | `company_snapshot` and `screen_companies` | done |
| 4 | Generated tool docs with a CI drift check, five worked recipes | done |
| 5 | Tool-selection eval suite, live smoke test in CI, remaining ADRs | next |
| 6 | npm and Docker release with provenance | |

## Licence

Source code: [MIT](LICENSE).

Data returned by this server is published by Companies House under the
[Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)
and is not covered by the MIT licence. If you redistribute it, carry the
attribution the OGL requires:

> Contains public sector information licensed under the Open Government
> Licence v3.0.

This project is not affiliated with or endorsed by Companies House.
