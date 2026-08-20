# companies-house-mcp

An MCP server for the UK [Companies House public data API](https://developer.company-information.service.gov.uk/).
Read-only, rate-limit aware, and designed around the questions people ask
rather than the endpoints the API happens to expose.

> **Status: phase 1 of 6.** The transport foundation is built and tested —
> configuration, HTTP client, rate limiter, cache and error model. The MCP
> server and its tools land in phase 2, and this package is not yet publishable
> or useful from a host. The roadmap is at the bottom.

## Why another API wrapper

The obvious way to build this is one MCP tool per endpoint. Twenty-two thin
pass-throughs, a weekend's work, and it is what most published MCP servers
are. It is also bad in three specific ways:

- Every tool schema sits in the model's context on every turn, whether the
  task needs it or not.
- It pushes the orchestration onto the model. "Is this supplier safe to
  onboard" becomes search, then profile, then officers, then charges, then
  insolvency — five round trips and five chances to lose the thread.
- Companies House payloads are large and mostly structural. `links`, `etag`,
  `kind` and repeated address blocks make up the bulk of an officers response
  and none of it is ever read.

So this server exposes eleven tools shaped around questions, two of which
(`company_snapshot` and `screen_companies`) do the fan-out server-side and
return one derived object. Retrieval tools accept a company number and refuse
a company name, because given a name a model will guess a number, and a
plausible wrong company number returns a real company that nothing downstream
flags as wrong.

## What exists today

| Piece | What it does |
|---|---|
| `loadConfig` | Validates every environment variable at startup and reports all the problems at once, naming the variable rather than the internal field. |
| `CompaniesHouseClient` | Basic-auth requests, per-request timeout, jittered retry on 429 and 5xx, conditional revalidation, stale-on-failure fallback. |
| `RateLimiter` | Sliding window sized to the documented 600 per five minutes, with a safety margin and serialised acquisition. |
| `ResponseCache` | Memory over disk, TTL per resource kind, atomic writes, corrupt entries treated as a miss. |
| `CompaniesHouseError` | Every failure carries a stable code, a plain sentence and a next step. |

101 tests, no network, no API key required to run them.

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
```

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

Four decisions are written up in [docs/adr](docs/adr):

1. [Recording architecture decisions](docs/adr/0001-record-architecture-decisions.md)
2. [The sliding-window rate limiter and its safety margin](docs/adr/0002-sliding-window-rate-limiter.md)
3. [Errors as data rather than exceptions](docs/adr/0003-errors-are-data.md)
4. [Caching, TTLs and the stale fallback](docs/adr/0004-caching-and-stale-fallback.md)

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
| 2 | Nine primitive tools with Zod schemas and shaped projections | next |
| 3 | `company_snapshot` and `screen_companies` | |
| 4 | Generated tool docs with a CI drift check, five worked recipes | |
| 5 | Tool-selection eval suite, live smoke test in CI, remaining ADRs | |
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
