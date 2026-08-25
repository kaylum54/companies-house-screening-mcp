# companies-house-screening-mcp

Screen UK companies against the [Companies House public
register](https://developer.company-information.service.gov.uk/) from an MCP
host. Batch screening of a supplier list, one-call company snapshots, and
factual signals rather than a risk score.

[![npm](https://img.shields.io/npm/v/companies-house-screening-mcp)](https://www.npmjs.com/package/companies-house-screening-mcp)
[![CI](https://github.com/kaylum54/companies-house-screening-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/kaylum54/companies-house-screening-mcp/actions/workflows/ci.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
and an attested container image, so the artefact is traceable to the commit
that produced it.

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
| **Runs hosted or local** | Streamable HTTP as well as stdio, so it works in claude.ai on web and mobile — with one shared rate-limit budget that is actually authoritative rather than one guess per process. [ADR 12](docs/adr/0012-remote-transport-alongside-stdio.md), [ADR 13](docs/adr/0013-one-key-shared-budget-fair-shares.md). |

Fifteen decisions are written up in [docs/adr](docs/adr), including the ones
that did not go the obvious way. [docs/mcp-surface.md](docs/mcp-surface.md)
describes what the server implements as an MCP server — capabilities,
transports, session and budget semantics — read off the running server rather
than from intent.

## Install

Two ways to run it, and they answer different questions.

### Hosted — you deploy it, users paste a URL

**There is no public instance of this server.** You run one; the people you
give the URL to need nothing but the link — no install, no Node, no Companies
House key of their own. That is the point of the hosted mode, and it is what
makes the server usable from claude.ai on web and mobile, where no local
process can be spawned.

Deploy to Cloudflare Workers or any single Node host —
[docs/deployment.md](docs/deployment.md) has both, with the costs and the
trade-offs stated. Then hand out your endpoint:

In claude.ai: Settings → Connectors → Add custom connector → paste the URL.
In Claude Code:

```bash
claude mcp add --transport http companies-house https://your-deployment/mcp
```

Your deployment holds one Companies House key and shares its 600 requests per
five minutes across everyone using it. Each caller is guaranteed a share, so a
50-company screening run cannot starve somebody's single lookup. A caller who
finds that tight can send `X-Companies-House-Api-Key` and get a private budget
of their own — in Claude Code, `--header "X-Companies-House-Api-Key: ..."`.

[**docs/rate-limits.md**](docs/rate-limits.md) is the full account: what the
budget is, exactly how much of it any one caller can take, how to read
`meta.rate_limit_remaining`, what happens when it runs out, and how to bring
your own key.

Before you make a deployment public, read the
[**what to expect**](docs/deployment.md#before-you-make-it-public) section: an
authless URL means anyone holding it spends your budget, and whether you may
pool one personal API key for third parties is a question for the Companies
House developer terms.

### Local — stdio

Still the right answer for one person on one machine: no infrastructure, no
hosting bill, and your own full rate-limit budget.

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
docker run --rm -i -e COMPANIES_HOUSE_API_KEY=your_key ghcr.io/kaylum54/companies-house-screening-mcp
```

Get a free API key at
[developer.company-information.service.gov.uk](https://developer.company-information.service.gov.uk/):
register, create an application against the **Live** environment, and create a
key of type **REST** (a stream key authenticates the same way but is for a
different service).

## What it is for

Two cases it was actually built around. More in
[docs/recipes](docs/recipes/README.md), which are executed on every build.

### Screening a supplier list

The quarterly onboarding list lands: forty new suppliers, first invoices due in
a fortnight. One call.

```json
{
  "tool": "screen_companies",
  "arguments": { "companies": ["04138203", "Bramble Facilities", "SC443221"] }
}
```

One row per company with its signal codes. Skip the rows carrying nothing; open
the ones with `accounts_overdue` or `outstanding_charges` using
`company_snapshot`.

The behaviour that earns its place is what happens to the awkward entries.
"Bramble Facilities" matches several companies, so it comes back under
`unresolved` **with its candidates** rather than resolved to a best guess. And
if the rate limit runs out at company 31, the remaining nine come back under
`not_screened` with the reset time — because a table that quietly stops at 31
looks exactly like a table where nine companies were clean.

Officers are excluded by default (one extra request per company), so the
officer-based signals cannot appear unless you ask for them. `sections_used`
says so on every response.

### Verifying an invoice before paying it

A first invoice from an unfamiliar supplier, or an email asking to change bank
details on an existing account.

```json
{
  "tool": "company_snapshot",
  "arguments": { "company_number": "04138203" }
}
```

Four checks in one response: the company exists, `status` is `active`,
`registered_office_address` matches what is printed on the invoice, and
`age_years` plus the `incorporated_within_last_year` signal say whether this
counterparty existed a month ago. The address is flattened to one line
specifically so it can be compared without reassembling nine fields.

**This is the case the no-names rule is for.** Invoice-redirection fraud works
because the paperwork looks right. If a tool accepts a company *name* and a
model invents a number to look it up, you get a confident "verified — active,
good standing" about **a different real company**, with real directors and real
filings, and nothing anywhere flags it. You would have used a verification step
to approve the fraud.

So passing a name is refused before any request is made:

```json
{
  "error": {
    "code": "INVALID_COMPANY_NUMBER",
    "message": "\"Royal Mail Group Limited\" looks like a company name, not a company number.",
    "next_step": "Call find_company with this name to get candidate company numbers, then call this tool again with the number of the right one. Do not guess a number: a plausible wrong company number returns a real company and nothing will flag it as the wrong one."
  }
}
```

What it cannot tell you: whether a bank account belongs to that company. This
raises or lowers suspicion; it does not settle it.

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

438 tests under Node and 12 inside `workerd`, no network and no API key required to run any of them.

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
npm run test:workers
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

**`npm test` runs under Node; `npm run test:workers` runs under `workerd`.**
The second is not a duplicate of the first. Node and workerd disagree — a
`globalThis.fetch` stored detached works on one and throws `Illegal
invocation` on the other — and that disagreement once passed every Node test
while breaking every request on the deployed Worker. `tests/workers/` runs the
real handler in the real runtime against the bindings `wrangler.toml`
declares, with only Companies House replaced. CI runs both, and neither is
optional before a deploy.

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

Runs through **OpenRouter** or the **Anthropic API** — set `OPENROUTER_API_KEY`
or `ANTHROPIC_API_KEY`. It defaults to `z-ai/glm-5.2` on OpenRouter, about 4p
for a full pass, because an eval nobody runs because of the bill is not doing
anything. Point `--model` at anything with tool support to compare.

Fourteen questions phrased the way a person would phrase them, scored on which
tool was called first, whether a forbidden tool was touched, whether the
arguments were right, and — the one that matters — whether the model invented
a company number that was not in the question. A case that passes two runs in
three is reported as flaky and fails, because intermittent selection means two
descriptions overlap.

Run across three models (GLM 5.2, Kimi K3, DeepSeek V4 Pro) it scores 93–98%.
The grounding group — given a company name and no number, search rather than
recall one — passes **7/7 on all three**. The failures clustered, and three of
them turned out to be defects in my own tool descriptions and one in the eval
itself, rather than in any model.

No Companies House key is needed; nothing is executed. Full comparison and
what it found in [evals/README.md](evals/README.md), reasoning in
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
| 6 | npm and Docker release with provenance | done — published 2026-08-20 |

## Licence

Source code: [MIT](LICENSE).

Data returned by this server is published by Companies House under the
[Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)
and is not covered by the MIT licence. If you redistribute it, carry the
attribution the OGL requires:

> Contains public sector information licensed under the Open Government
> Licence v3.0.

This project is not affiliated with or endorsed by Companies House.
