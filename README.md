# companies-house-screening-mcp

Screen UK companies against the [Companies House public
register](https://developer.company-information.service.gov.uk/) from an MCP
host. Batch screening of a supplier list, one-call company snapshots, and
factual signals rather than a risk score.

> **Status: phase 6 of 6.** Eleven tools, documentation generated from the
> running server and gated in CI, a tool-selection eval, and fixtures recorded
> from the live API. Release pipeline built; not yet published.

## There is another one, and you should know about it

[`companies-house-mcp`](https://www.npmjs.com/package/companies-house-mcp) by
[@aicayzer](https://github.com/aicayzer/companies-house-mcp) has existed since
July 2025, is at v4.0.0, and is actively maintained. It covers the same API.
This project is not first and does not claim to be.

The two are shaped differently, so which one fits depends on what you are
doing.

**Use theirs if you want breadth.** It exposes more of the API — registers,
exemptions, UK establishments, officer disqualifications — and, importantly,
it can **download the filed documents themselves**. This one deliberately
does not: the Companies House document API is out of scope here.

**Use this one if you are screening rather than browsing.** The differences
that matter:

| | |
|---|---|
| **Batch screening** | `screen_companies` takes up to 50 names or numbers and returns one row each. Nothing else here does this. |
| **Never guesses a company number** | Retrieval tools refuse a company name outright, before any request. Given a name, a model produces a number that looks right, and a plausible wrong number returns *a different real company* that nothing downstream flags. [ADR 5](docs/adr/0005-question-shaped-tool-surface.md). |
| **Signals, not scores** | Facts read off the register with the date or name behind each, and deliberately no rating. [ADR 7](docs/adr/0007-signals-not-scores.md) has the argument. |
| **Nothing dropped quietly** | Partial results are labelled; a screening table that comes back short always says why. [ADR 8](docs/adr/0008-partial-results-and-budget-honesty.md). |
| **Documentation that cannot go stale** | The tool reference is generated from the running server and every example executes; CI fails if either drifts. [ADR 9](docs/adr/0009-documentation-is-generated-and-gated.md). |
| **A tool-selection eval** | Asks a real model which tool it reaches for, and fails on flakiness. [ADR 10](docs/adr/0010-tool-selection-eval.md). |

Eleven decisions are written up in [docs/adr](docs/adr), including the ones
that did not go the obvious way.

## Install

```bash
npx -y companies-house-screening-mcp
```

Host configuration:

```json
{
  "mcpServers": {
    "companies-house": {
      "command": "npx",
      "args": ["-y", "companies-house-screening-mcp"],
      "env": { "COMPANIES_HOUSE_API_KEY": "your_key" }
    }
  }
}
```

Or with Docker — note `-i` and no `-t`, because a TTY corrupts the JSON-RPC
framing:

```bash
docker run --rm -i -e COMPANIES_HOUSE_API_KEY=your_key ghcr.io/OWNER/companies-house-screening-mcp
```

Get a free API key at
[developer.company-information.service.gov.uk](https://developer.company-information.service.gov.uk/):
register, create an application against the **Live** environment, and create a
key of type **REST** (a stream key authenticates the same way but is for a
different service).

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
  `kind`, per-item ETags, filing-transaction arrays, nine-key address objects.
  Shaping them away saves between 36% and 72% depending on the endpoint,
  measured against real recorded responses rather than assumed (`npm run
  measure`).

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

259 tests, no network, no API key required to run them.

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

The suite runs offline against fixtures recorded from the live Companies House
API, so a fresh clone works with nothing configured. `npm run record-fixtures`
re-records them — see [tests/fixtures/README.md](tests/fixtures/README.md) for
which companies they come from and why those were chosen.

Once you hold a key, copy `.env.example` to `.env` and fill it in:

```bash
npm run test:live
```

Every development command reads that file. Anything already set in your shell
wins over it. The published server does **not** read a `.env` unless
`CH_ENV_FILE` names one — a host launches it with the host's working
directory, and picking up whatever `.env` happens to be there is a good way to
load the wrong credentials.

That test runs nightly in CI. Its job is not to pass — it is to fail loudly the
week Companies House changes a field, so the fixtures get refreshed before a
user finds the drift instead.

## The tool-selection eval

Every test in this repository asks *does the tool work*. One thing none of
them can ask is whether a model **reaches for the right tool** when a person
asks a real question — a tool can be correct, fast and fully covered and still
never get chosen, because its description is vague or overlaps another. That
is the most common real defect in published MCP servers.

```bash
npm run eval -- --repeat 3
```

Fourteen questions phrased the way a person would phrase them, scored on which
tool was called first, whether a forbidden tool was touched, whether the
arguments were right, and — the one that matters — whether the model invented
a company number that was not in the question. A case that passes two runs in
three is reported as flaky and fails, because intermittent selection means two
descriptions overlap.

No Companies House key is needed; nothing is executed. Details in
[evals/README.md](evals/README.md), reasoning in
[ADR 10](docs/adr/0010-tool-selection-eval.md).

## Design notes

Eleven decisions are written up in [docs/adr](docs/adr):

1. [Recording architecture decisions](docs/adr/0001-record-architecture-decisions.md)
2. [The sliding-window rate limiter and its safety margin](docs/adr/0002-sliding-window-rate-limiter.md)
3. [Errors as data rather than exceptions](docs/adr/0003-errors-are-data.md)
4. [Caching, TTLs and the stale fallback](docs/adr/0004-caching-and-stale-fallback.md)
5. [Question-shaped tools, and why a name is refused](docs/adr/0005-question-shaped-tool-surface.md)
6. [Why the result payload is sent twice](docs/adr/0006-duplicated-result-payload.md)
7. [Signals, not scores](docs/adr/0007-signals-not-scores.md)
8. [Partial results, and never dropping anything quietly](docs/adr/0008-partial-results-and-budget-honesty.md)
9. [Generated documentation, gated in CI](docs/adr/0009-documentation-is-generated-and-gated.md)
10. [The tool-selection eval](docs/adr/0010-tool-selection-eval.md)
11. [Tag-driven releases, signed with provenance](docs/adr/0011-release-and-provenance.md)

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
| 5 | Tool-selection eval suite, live smoke test in CI, remaining ADRs | done |
| 6 | npm and Docker release with provenance | pipeline built, not yet published |

## Licence

Source code: [MIT](LICENSE).

Data returned by this server is published by Companies House under the
[Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)
and is not covered by the MIT licence. If you redistribute it, carry the
attribution the OGL requires:

> Contains public sector information licensed under the Open Government
> Licence v3.0.

This project is not affiliated with or endorsed by Companies House.
