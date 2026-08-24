# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — the server is reachable without a laptop

- **Streamable HTTP transport**, alongside stdio rather than replacing it. This
  makes the server usable from claude.ai on web and mobile, hosted agent
  platforms, and anything else that cannot spawn a local process. stdio is
  unchanged and remains the right answer for a single user on one machine.
  New binary: `companies-house-screening-mcp-http`.
  ([ADR 12](docs/adr/0012-remote-transport-alongside-stdio.md))
- **Cloudflare Workers deployment**, with the rate-limit window in a Durable
  Object. A Durable Object is single-threaded and globally unique per key, so
  the budget stays correct under scale-out by construction rather than by being
  told to run one instance. Requires the Workers Paid plan, because a single
  `screen_companies` run makes ~150 external subrequests in one invocation and
  the free plan allows 50. See `wrangler.toml` and
  [docs/deployment.md](docs/deployment.md).
- **Bring your own key**, via `X-Companies-House-Api-Key`. A caller supplying
  one gets a private rate-limit window while still sharing the response cache.
  The key is never logged, cached, returned in a tool result, or exposed to the
  model; a malformed value is treated as absent rather than passed into an auth
  header.
- **An authless-now, OAuth-ready identity seam.** `AuthProvider` resolves a
  request to a `ClientIdentity` that everything downstream consumes without
  knowing how it was established, so adding OAuth later means writing one
  provider rather than reworking the limiter and every entry point.
  ([ADR 15](docs/adr/0015-authless-now-oauth-ready.md))

### Fixed — the rate limiter is now authoritative

- **The budget is shared, not guessed.** It counted requests per process while
  Companies House meters per key, so several sessions on one key each believed
  they owned the whole window. The arithmetic moved into a pure
  `SlidingWindowBudget` behind a `BudgetStore`, letting identical code run in
  one process or in a Durable Object.
  ([ADR 13](docs/adr/0013-one-key-shared-budget-fair-shares.md))
- **Fair shares, so one caller cannot starve another.** Each caller is
  guaranteed a reservation and may exceed it only while the window has room.
  The headroom held back scales with the callers actually active, so a lone
  caller on a quiet server keeps 499 of the 570-request effective window — all
  of it bar one held-back reservation — while a newcomer is still guaranteed a
  share on arrival.
- **`peek` no longer promises more than `acquire` grants.** It approximated the
  admission rule instead of deriving from it. `screen_companies` sizes its
  batch against `peek`, so the bug was a table promising rows the limiter would
  then refuse — the exact silent shortfall
  [ADR 8](docs/adr/0008-partial-results-and-budget-honesty.md) exists to
  prevent.
- **`screen_companies` asks the budget rather than reading a cached figure.**
  On a shared deployment the cached snapshot can be a whole window out of date.

### Changed — breaking, at 0.x

- `RateLimiter.snapshot()` is now **async**, and returns the caller's view of
  the budget. `RateLimiter.lastKnown` is the synchronous cached value, for
  response metadata only. `penalise` and `applyServerHeaders` are async too.
- `ResponseCache` takes a **`store`** rather than a `dir`. Node callers pass
  `new FileCacheStore({ dir })`; a Worker passes `KvCacheStore`; omitting it
  gives a memory-only cache.
- `defaultCacheDir`, `packageVersion` and `loadEnvFile` moved to `src/node/`.
  They are still exported from the package root. `config.cacheDir` is now
  optional, because only a runtime with a filesystem has anywhere to point it.
  ([ADR 14](docs/adr/0014-runtime-portable-core.md))

### Security

- **`X-Forwarded-For` is no longer trusted by default.** It is set by the
  caller, so a client varying it per request would have minted a fresh
  fair-share reservation each time and defeated the limiter entirely. It is now
  consulted only when `CH_TRUST_PROXY_HEADERS=true` says a trusted proxy is in
  front. Cloudflare's `CF-Connecting-IP` remains trusted because the platform
  sets it and strips any client-supplied copy.
- **The Worker no longer returns configuration validation detail to callers.**
  A misconfigured deployment answered an unauthenticated request with the list
  of environment variables that failed validation. The detail now goes to the
  operator's logs and the caller gets "The server is misconfigured."

### Fixed — found by the code-review pass

- **A private budget is now one per key, not one per session.** Creating a
  store per session meant a caller reconnecting between calls received a fresh
  full window each time, so a client that reconnected per request was never
  rate-limited at all. It also disagreed with the Cloudflare path, which
  already keyed by caller.
- **`CF-Connecting-IP` is gated like `X-Forwarded-For`.** It is only
  trustworthy inside Cloudflare's runtime; arriving at a Node process it is a
  header the caller typed, and trusting it reopened the bypass the previous fix
  had just closed.
- **The session registry is bounded.** Idle sessions are swept and the least
  recently used is evicted at `CH_MAX_SESSIONS`; previously every `initialize`
  retained a server and transport for the life of the process.
- **Response metadata no longer reports another caller's budget.** `rateLimit`
  read the shared limiter's cached value, so a request served entirely from
  cache could report whatever the last caller saw — including `remaining: 0`.
  Each session now tracks its own.
- **No more "Retry in 0 seconds."** When budget remained but not a whole
  company's worth, `not_screened` quoted a reset time of zero. Fair sharing
  makes that state common; the message now says what to do instead.
- **A failed Durable Object restore no longer latches.** One rejected storage
  read left a permanently rejected promise that failed every later request
  closed. The next request now retries.
- **The Worker reports its real version** — inlined at build time — rather than
  `0.0.0`, and its pooled limiter now honours `CH_RATE_LIMIT` instead of
  falling back to the documented default when reporting its ceiling.

### Fixed — found by the second review pass

- **Response metadata reported another caller's budget.** The first fix changed
  only the `rateLimit` getter; the four `meta.rateLimit` sites inside `get()`
  still read the shared limiter, so a cache-served response could report a
  stranger's remaining count.
- **A caller supplying the deployment's own key got a second window on it.**
  Companies House meters the key, so two windows on one credential would let
  the server spend roughly twice the allowance it has. That caller now joins
  the pool, which is where the key's traffic already is.
- **Exhausting the limiter's retry bound reported `INTERNAL_ERROR`.** The bound
  guards against a frozen clock but is reachable with a healthy one under
  contention, and callers were told their request was a server bug and not
  retryable. It is now `RATE_LIMITED` with a retry time.
- **Private budgets are bounded**, like sessions. The map was keyed by
  caller-supplied key fingerprint on an authless endpoint, so rotating
  fabricated keys grew it without limit.
- **A failed `listen` no longer crashes with an uncaught exception.** An
  occupied port bypassed the entry point's error handling entirely; it now
  reports the port and exits with the config code.

### Fixed — found by the third review pass

- **A Durable Object hiccup could fail a request the upstream had already
  answered.** `observe` runs after every Companies House response and was
  unguarded, so a coordinator blip turned a successful 200 into a thrown error.
  Both `observe` and `penalise` are best-effort corrections and now stay that
  way.
- **An unreachable limiter reported "you hit the rate limit."** It now reports
  `UPSTREAM_UNAVAILABLE` and fails immediately, instead of spending the full
  wait window retrying something that is down and then blaming the caller's
  budget.
- **Idle sessions were never actually swept.** The sweep ran only when a new
  client initialized, so `CH_SESSION_IDLE_MS` reclaimed sessions when the
  server was busy and never when it was quiet. It now runs on any request,
  throttled.
- **`CH_CACHE_DIR=` became a fatal config error**, and `CH_CACHE_DIR='   '` a
  directory named three spaces. Trimming used to happen inside
  `defaultCacheDir` and was lost when it moved; blank now means unset again.
- **Persisted Durable Object state is validated before loading.** It outlives
  any deploy, exactly as a KV namespace does, and an unreadable value threw
  inside `blockConcurrencyWhile` — permanently refusing that credential's
  window, because the bad value stayed in storage.
- **A new session's first cache-hit response reported the previous caller's
  budget.** The per-session figure was seeded from the shared limiter.

### Fixed — found by the fourth review pass

- **`screen_companies` described a limiter outage as an exhausted budget.**
  `RateLimitSnapshot` dropped the reason a budget was zero, so an unreachable
  coordinator produced a table where every row blamed a spent five-minute
  window. The single-lookup path had been fixed for exactly this and the two
  tools contradicted each other during the same outage. The reason is now
  carried through, and the batch tool reports the outage.
- **`isBudgetState` checked the container but not its contents.** A stored
  `clients` entry that was not an array passed the guard and threw inside
  `blockConcurrencyWhile` — the failure the guard exists to prevent, one level
  deeper than it was looking.
- **Two concurrent first requests to a Durable Object could each build a
  window.** The later assignment won and the slot granted against the discarded
  one vanished from the persisted count. The in-flight restore is now memoized.
- **An actively-used private budget aged as though idle.** Its timestamp was
  only set when a session was created, so a busy window could be evicted and
  the caller's next reconnect would build a second one on the same credential —
  metering one Companies House key against two local windows.

### Fixed — found by the fifth review pass

- **A stale reset time expired a fresh rate-limit hint.** Companies House sends
  `X-Ratelimit-*` inconsistently; a response carrying only a reset, followed by
  one carrying only a count, left the old reset in place, which discarded the
  new count the instant it was read — throwing away the server's warning and
  running the limiter into 429s, the one thing these headers exist to avoid.
- **An in-use private budget could be evicted by the size cap.** The live
  session kept the orphaned store, so the caller's next reconnect built a
  second full window on the same credential. Budgets held by a live session are
  now excluded from eviction, and the map stays bounded because sessions are.
- **The Durable Object wrote its whole window on every upstream response.**
  `observe` persisted a correction the code itself calls "never the source of
  truth", roughly doubling storage traffic on the request path. Penalties still
  persist, because a 429 must survive an eviction.
- **A non-object request body crashed the Durable Object into a fail-closed
  outcome** instead of returning 400, because `JSON.parse` accepts `null`.
- **The startup log dropped `clientReservation`** — the derived value was
  overwritten by the config spread that followed it — in exactly the case where
  someone would want to read it.
- **The portability guard only matched static imports**, so a future
  `await import('node:fs')` would have slipped past. It was the form `cache.ts`
  itself used to contain.

### Changed — closing the cross-session leak by construction

- **`RateLimiter.acquire` now returns the budget for that acquisition.**
  Callers previously read `lastKnown` back off the limiter afterwards, and one
  limiter is shared by every pooled session — so another session's continuation
  running between the `await` resolving and the read would be reported as this
  session's. Three separate variants of that leak were fixed during review (the
  getter, the four call sites, and the seed); handing the value back removes
  the shape of the bug rather than its instances.

### Fixed — found by the sixth review pass

- **A refused initialize orphaned a whole session.** The SDK answers 406 for an
  `Accept` without `text/event-stream` and 415 for a non-JSON `Content-Type`,
  after the server, transport and any private-budget reference have been built
  and before `onsessioninitialized` fires — so none of it was ever registered,
  swept, evicted or closed. Unauthenticated memory growth the session cap could
  not see, and with a rotating key header it pinned private budgets in place
  permanently.
- **Closing a session released its private budget twice.** Both
  `onsessionclosed` and `onclose` fire on a delete, so closing one of two
  sessions on the same caller key took the reference count to zero while the
  other was live — making an in-use budget an eviction candidate, which is the
  "one key, two local windows" failure the refcount exists to prevent. Release
  is now idempotent per session.
- **A server-imposed block reported the local window's reset time.** A
  `remain: 0` hint can block a window that still has local room; quoting the
  local expiry gave a retry time that could be minutes early, and
  `screen_companies` prints it verbatim.
- **`isBudgetState` did not validate the restored server-hint fields.** A
  non-numeric `serverRemaining` made the available count `NaN`, which passes a
  `<= 0` guard and reached `screen_companies` as `slice(0, NaN)` — every
  company reported unaffordable against a budget that was never spent.

### Fixed — found by the seventh review pass

- **A hint-imposed block reported seconds for a wait lasting minutes.** A
  `remain: 0` header with no `reset` blocks for a full window from when it was
  recorded, but the retry time came from the local oldest timestamp — so the
  limiter retried into a guaranteed refusal and `screen_companies` printed the
  wrong number verbatim.
- **A server hint is now the server's whole view, not a patch onto the last
  one.** The two headers arrive independently, and pairing a new one with a
  leftover old one is wrong in both directions: a fresh count with a stale
  reset is expired the moment it is read, and a fresh reset with a stale
  `remaining: 0` extended a block that should have ended by an entire window.
  Only the first direction was handled.
- **The Worker answered `GET /mcp` by opening a stream it then destroyed.** The
  deployment is stateless, so it built a session, opened an SSE stream and tore
  it down in the same request — leaving a client that opens the notification
  stream reconnecting in a loop, paying a full config parse, auth and Durable
  Object wiring each time. Non-POST is now refused with 405 before anything is
  built, as the Node entry point already did.

### Fixed — found by the eighth review pass

- **A short server hold was padded out to a whole window.** The retry time
  folded in the local oldest-entry expiry even with hundreds of local slots
  free, so a five-second hold was reported as five minutes — long enough that
  the limiter gave up against its wait deadline instead of simply waiting. Each
  constraint is now quoted only while it is the one actually blocking.
- **Every environment variable now treats blank as unset**, not just
  `CH_CACHE_DIR`. `CH_HTTP_HOST=`, `CH_HTTP_PORT=` and friends each exited 78 —
  the same footgun, in the deployment surface this release introduces, where
  compose files and Kubernetes manifests produce empty values by accident.
- **The Worker relays `WWW-Authenticate` on a failed authentication.** Latent
  while the default provider admits everyone, but a 401 without it leaves an
  MCP client nothing to discover, which is the OAuth path the seam exists for.

### Fixed — found by the ninth review pass

- **stdio no longer inherits the hosted server's give-up deadline.** Adding a
  wait ceiling for HTTP silently applied it to the local server too, so an
  over-budget call now failed immediately where it used to wait for the window.
  The ceiling belongs to a server — where a hung request holds a connection and
  the client times out anyway — and the entry points now supply it. `stdio`
  waits, as it always has, and `CH_MAX_WAIT_MS` overrides either.
- **A client refused by its own share was told to come back far too early.**
  The retry time quoted the client's oldest request expiring, which frees one
  slot, while a client that burst past its reservation before the window filled
  needs many. It is now derived from the admission rule: whichever of "enough
  of mine age out" or "the window reopens for bursting" happens first.

### Added — concurrent requests for the same URL are coalesced

- **Ten sessions asking for the same company at once now make one call.** The
  cache only helps once an answer exists, and `screen_companies` fans out
  concurrently by design — so simultaneous misses on the same supplier each
  spent a slot of the budget the shared cache exists to conserve. Followers
  wait for the leader and are reported as cached, which is what happened to
  them: they contacted nobody. A failed request is cleared rather than left for
  later callers to inherit.

### Fixed — found by the tenth review pass

- **The `session opened` log claimed a private budget that did not exist.** A
  caller supplying the deployment's own key is routed into the pool, but the
  log reported the header rather than the outcome.
- **`isBudgetState` accepted non-finite numbers.** Durable Object storage
  round-trips `NaN` and `Infinity`, and a non-finite `blockedUntil` latches
  permanently through `Math.max` — silently disabling 429 penalties for that
  credential.
- **A throw during the handshake pinned a private-budget refcount.** Nothing is
  registered at that point, so nothing else would ever release it, and a pinned
  entry is permanently non-evictable.

### Fixed — found by the first real deployment

- **Every upstream request failed on Cloudflare with `Illegal invocation`.**
  The client stored `globalThis.fetch` in a field and called it detached. Node
  tolerates that; workerd requires `globalThis` as the receiver and throws.
  The result was the worst shape a bug can take — every test passing under
  Node, every request failing on the deployed Worker. `fetch` is now bound, and
  a regression test reproduces workerd's receiver rule inside Node so the
  suite can actually see it.
- The portability guard now also catches runtime globals stored without
  binding, not just `node:` imports. The original rule could never have found
  this.

### Added — guardrails

- `tests/runtime-portability.test.ts` fails on any `node:` import outside
  `src/node/`, with `node:crypto` as a single audited exception. It found
  `version.ts` importing `node:module` on its first run — a violation that
  would have broken the Worker at deploy time and that no test running under
  Node would have noticed.
- 74 new tests covering fair sharing and starvation, `peek`/`acquire`
  agreement, the HTTP handshake and tool parity with stdio, session and budget
  isolation, key handling, Durable Object eviction and restore, and fail-closed
  behaviour when the limiter is unreachable.

### Changed

- Publishing moved to npm Trusted Publishing. The workflow authenticates by
  OIDC against the trusted publisher configured on the package, so there is no
  `NODE_AUTH_TOKEN` and no `NPM_TOKEN` secret — nothing to leak and nothing to
  rotate. It replaced a granular token, which npm rejected anyway: publishing
  from CI requires a token flagged to bypass 2FA, and npm is removing those for
  direct publishing in January 2027.

### Changed — tool descriptions, driven by the expanded eval

- `screen_companies` now leads with its trigger condition — *more than one
  company* — instead of an example use case. Two of four phrasings of the same
  intent had been missing it and looping `company_snapshot` at four times the
  request cost.
- The read-only rule moved to the first line of the server instructions and is
  now directive. Asked to file a confirmation statement, the model had been
  calling a read tool on two runs in three and presenting it as progress.

### Changed — the eval is now diagnostic rather than a smoke test

- 15 cases to 58, weighted towards ones designed to fail, in nine categories:
  grounding, paraphrase, number-trap, near-miss, out-of-scope, not-uk, noise,
  primitive and composite.
- Paraphrase sets ask one intent four ways. Phrasings that choose different
  tools are reported as a finding about the descriptions even when each
  individual choice is defensible.
- Per-category reporting. A single overall percentage says nothing about what
  to fix.
- Number-trap cases forbid *any* company number, because those questions
  contain none. A model defeated the earlier decoy list by deriving a new
  value — it turned the VAT number 745938421 into 07459384 and looked it up.
- `--case` accepts a category as well as an id.
- Result: 93% before the description fixes, 98% after, on GLM 5.2.

### Added — the eval runs through OpenRouter as well as Anthropic

- `--provider openrouter|anthropic`, auto-detected from whichever key is set.
  If both are present OpenRouter wins unless `--provider` says otherwise, and
  an explicit provider whose key is missing fails rather than silently using
  the other one.
- OpenRouter defaults to `z-ai/glm-5.2` — about 4p for a full pass against
  ~22p on a frontier model. Running the same questions across several models
  is the better use of the eval anyway: a description only a frontier model
  reads correctly is a description with a problem.
- Result files record the provider and model. A pass rate without a model
  beside it means nothing.
- Fixed while testing it: a null entry in a provider's `tool_calls` array
  crashed the parser. Optional chaining guards the property, not the object
  holding it.

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
