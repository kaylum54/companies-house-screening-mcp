# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — phase 6, the release pipeline

- Tag-driven release workflow. Publishing to npm with `--provenance`, and a
  container image to GHCR with build attestation, both from a `v*` tag. The
  workflow refuses to publish when the tag and `package.json` version disagree.
- `Dockerfile`: multi-stage, non-root, production dependencies only, installed
  with `--ignore-scripts`. Stdio server — run it with `-i` and without `-t`.
- `scripts/release-check.ts` asserts what no unit test can: a shebang on the
  entry point, the `repository` field provenance requires, and that no `.env`,
  `.npmrc`, test, fixture or doc ends up in the tarball. Wired into
  `prepublishOnly` so a publish cannot skip it.
- Verified by installing the packed tarball into a clean directory and
  completing a real MCP handshake from it.

### Changed — renamed

- The package is `companies-house-screening-mcp`. `companies-house-mcp` was
  already taken by an actively maintained v4.0.0 covering the same API, which
  the README now names and compares against on the first screen. The new name
  says what distinguishes this one.
- Source maps and declaration maps are no longer published — they pointed at
  `src/`, which is not in the tarball. 96 files and 336 KB down to 50 and
  214 KB.

### Changed — fixtures are now recorded from the live API

- Fixtures come from real Companies House responses: Royal Mail Group Limited
  (04138203) for an active company, Marine and General Mutual Life Assurance
  Society (00000006) for a dissolved one, Carillion PLC (03782379) for
  insolvency. Subjects are institutions and widely-reported failures rather
  than small trading businesses, because the names appear in generated
  documentation and the framing around public data would otherwise be ours.
- The recorder picks whichever officer holds the most appointments, so the
  officer-network fixture demonstrates the tool instead of showing a company
  secretary with one appointment.
- Recipes rewritten to describe what the register shows rather than to allege
  what it means, and to carry an explicit note that nothing is asserted about
  any company or person beyond the register itself.

### Fixed — found by recording real data

- The projection saving was measured against invented fixtures at 29–42%.
  Against real payloads it is **36–72%**: per-item ETags, filing-transaction
  arrays and identity-verification blocks are heavier than anything that was
  guessed. README and the regression test updated to the measured range.
- 00000006 was documented as an active trading company. It has been dissolved
  since 2018.
- Discovered and pinned: a company profile's `has_charges` flag can report
  false while the charges endpoint returns fifteen. The charges section is
  authoritative and no signal reads the flag.

### Fixed

- `npm run test:live` failed on Windows. The script used the bash-only
  `VAR=value command` prefix, which npm runs through cmd.exe on Windows —
  producing `'CH_LIVE_SMOKE' is not recognized`. The live test now has its own
  vitest config instead of an environment-variable switch, so no inline env
  prefix is needed and the command works identically on every platform. The
  same bash-only form has been removed from the documentation.

### Added — `.env` support

- Development commands (`npm test`, `test:live`, `eval`, `record-fixtures`)
  read a `.env` at the repository root. Values already set in the shell win
  over the file.
- The published server does **not** read a `.env` by default. A host launches
  it with the host's working directory, so reading whatever `.env` is there is
  a way to load the wrong credentials. Set `CH_ENV_FILE` to an explicit path to
  opt in; an unreadable path exits with EX_CONFIG rather than starting.
- `.env.example` now documents both keys, including how to get them and which
  Companies House key type is the right one.

### Added — phase 5, the tool-selection eval

- `npm run eval` asks a real model which tool it would reach for, given the
  server's real tool definitions and real instructions. Fourteen questions
  phrased the way a person would phrase them.
- Scored on tool choice, forbidden tools, arguments, and whether a company
  number was invented — the last being the eval for the design decision the
  server is built around.
- Flaky counts as failed. A case passing two runs in three means two
  descriptions overlap; the runner exits non-zero on failures *and* flakes.
- The scoring is pure and covered exhaustively without a key, because an eval
  whose scoring is wrong is worse than none.

### Added — phase 4, generated documentation

- `docs/tools`: a reference page per tool, generated from the running server
  over a real MCP client, so what is documented is what a host is actually
  told rather than what the schemas were meant to say.
- `docs/recipes`: five worked examples — supplier screening, director conflict
  check, invoice verification, debtor risk screen, competitor filing watch.
  Every call on every page is executed when the docs are built; the responses
  are real output, and a recipe that stops working stops generating.
- `npm run docs:check` exits 1 on any difference from what is committed. Wired
  into CI ahead of the tests, into `prepublishOnly`, and into the test suite so
  the failure arrives locally first.
- `npm run measure` for the projection size table.

### Added — phase 3, the composite tools

- `company_snapshot`. Profile, serving officers, charges and insolvency in one
  call, with signals derived across all of them.
- `screen_companies`. Up to 50 names or numbers in, one row each out.
- `signals`: facts read off the register as `{ code, detail }`. Deliberately
  no score, grade or traffic light — see ADR 7.
- Partial results. A snapshot survives one broken section and reports it under
  `sections_unavailable`; `sections_included` tells a missing signal apart from
  a section nobody read.
- A 404 on charges or insolvency is treated as "none", which is what Companies
  House means by it, rather than as an outage.
- `screen_companies` never guesses an ambiguous name — those come back under
  `unresolved` with candidates — and never truncates silently: anything skipped
  for rate-limit budget comes back under `not_screened` with the reason and the
  reset time.
- Bounded-concurrency helper, four requests in flight.

### Added — phase 2, the tool surface

- MCP server over stdio, with nine read-only tools: `find_company`,
  `find_officer`, `get_company`, `get_officers`, `get_filing_history`,
  `get_charges`, `get_psc`, `get_insolvency`, `get_officer_appointments`.
- Projection layer. Upstream payloads are read defensively field by field;
  output is validated strictly against published Zod schemas. Derived fields
  that Companies House does not provide: overdue-filing flags, company age,
  outstanding charge count, active appointment count, officer IDs lifted out
  of URLs.
- Retrieval tools refuse a company name and name `find_company` as the next
  step, before any request is made.
- `find_company` reports `disambiguation_needed` when several candidates come
  back and none matches exactly.
- Officer service addresses are withheld unless `verbose` is set.
- `scripts/measure-projections.ts`, and a test that holds the README's size
  claim to the measured range.

### Changed

- Corrected the claimed saving from the projection layer. It was described as
  "roughly an order of magnitude" in phase 1; measured against the fixtures it
  is 29% to 42%. The code was right, the claim was not.
- `bin` now points at `dist/bin.js`. Importing the package no longer starts a
  server or reads the environment.
- `RequestMeta` carries `ageMs` for cached answers, surfaced to callers as
  `meta.age_seconds`.

### Added — phase 1, the transport foundation

- HTTP client for the Companies House public data API with basic-auth key
  handling, per-request timeouts and jittered retry on 429 and 5xx.
- Sliding-window rate limiter sized to the documented 600 requests per five
  minutes, with a configurable safety margin and optional tightening from the
  undocumented `X-Ratelimit-*` response headers.
- Two-layer response cache (memory and disk) with per-resource TTLs and
  conditional revalidation where the API returns an HTTP `ETag`.
- Typed error model. Every failure carries a stable code, a plain-language
  message and a next-step hint rather than surfacing a stack trace.
- Company number normalisation, including zero-padding of short numeric input.
- Structured stderr logger. Nothing is ever written to stdout, which the stdio
  transport owns.
