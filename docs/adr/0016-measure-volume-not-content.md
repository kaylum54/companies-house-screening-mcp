# 16. Measure volume and outcome, never content

- **Status:** accepted
- **Date:** 2026-08-25

> For how to turn this on and what to query, see
> [docs/observability.md](../observability.md).

## Context

A hosted deployment spends a rate limit that everybody shares, from a key that
belongs to one person. Until now the only window into a running one was
`wrangler tail`, which shows what is happening while somebody is watching and
nothing at all when they are not. Every failure mode that matters is therefore
silent:

- the key is throttled by Companies House and every caller sees `RATE_LIMITED`
- one caller drains the pooled window every five minutes, all day
- the Durable Object has a bad hour and every request fails closed
- the cache stops hitting and upstream cost triples

The operator finds out by trying it. That is tolerable while the only user is
the person who deployed it and stops being tolerable the moment a URL is
shared.

The awkward part is not collecting numbers. It is deciding what a server may
remember about the people using it. This one sees *which companies a user is
checking*, which is commercially sensitive in a way the register itself is
not: the register is public, but the fact that a particular buyer is running
due diligence on a particular supplier is not. Analytics is retained for three
months and read by whoever runs the deployment.

## Decision

**Measure volume, cost and outcome. Never content, never identity.**

Recorded, per request: the tool called, whether it succeeded or failed, the
error code, the refusal cause and how many sub-requests were refused, how many
upstream calls it made, how many answers came from cache, retries, upstream
429s, stale answers served, the budget at the end, whether the caller brought
their own key, the duration, and the deployed version.

Deliberately **not** recorded:

- **Company numbers and search queries.** The single most sensitive thing
  flowing through this server. Nothing operational needs them: "how many
  requests" and "how expensive" are answerable without ever knowing which
  company.
- **Any per-caller identifier**, including the truncated fingerprint the
  limiter already computes. A hashed IP address is still pseudonymous personal
  data, and nothing operational needs it: contention shows up in the refusal
  count and the budget column without anybody being named. (An earlier draft
  claimed a caller *count* answered the question. There is no such column, and
  saying there was would have been a justification for a capability that does
  not exist.)
- **API keys, URLs, request bodies, headers.**

**The rule is enforced by an allowlist, not by a filter.** `MetricsRecorder`
exposes counters and two label methods rather than a general
`record(name, value)`, and each label is emitted only if it is a value this
codebase defines — a registered tool name, a typed error code, or one of the
handful of literals in `src/telemetry/recordable.ts`. Anything else records
`other`.

The first version of this used a character filter — keep `[a-z0-9_]`,
truncate at 48 — and described it as a redaction step. It is not one, and the
audit that caught it was right to be blunt: a company number is eight
characters drawn from exactly that set, so `label('SC123456')` returns
`'sc123456'`, intact, and any path, query or name under 48 word characters
survives readably. A character class cannot distinguish `get_company` from
`sc123456`; only membership of a known set can. The filter remains as a
normaliser, and `tests/metrics.test.ts` now pins the fact that it does *not*
redact, so nobody reads it as a control again.

What this changes in practice today is nothing — every call site already
passed a literal or a closed-set code. What it changes is the failure mode of
a careless change six months from now: a call site handing over a path or a
session id records `other` instead of publishing it for three months.

**One data point per invocation, not per upstream call.** Analytics Engine
accepts 250 `writeDataPoint` calls per invocation and a fifty-company
`screen_companies` run makes roughly 150 upstream requests — 200 with officers
included. Per-call writes would sit against that ceiling and silently drop the
tail of exactly the runs worth seeing. A pure accumulator collects the request
and the Worker flushes once.

**The shaping lives in the portable core.** `src/telemetry/metrics.ts` owns no
clock, does no I/O and imports nothing from a platform. That is not tidiness:
Miniflare's Analytics Engine binding is `writeDataPoint(_event) {}`, a no-op
stub, so a test inside `workerd` can prove a write was accepted and never what
was in it. Had the shaping lived in the Cloudflare adapter it would have been
effectively untestable.

**Alerting reads the Durable Object, not the analytics.** The obvious design
is a Cron Trigger querying the Analytics Engine SQL API, which needs an
account-scoped API token. Storing one inside an authless Worker that anybody
on the internet can reach adds a credential to the most exposed component in
the system in order to watch it. The scheduled run reads the same
authoritative counter every request already consults, so there is no read
token anywhere. The only secret involved is the delivery address, which is
optional and must be `https`.

**Alerting waits for two consecutive bad checks**, and no two *firing*
messages come within half an hour of each other. A busy five minutes
legitimately drains the window — that is the design working. Alerting that
fires on it gets muted, and a muted channel is worse than none because it is
still believed to work.

The gap is not belt-and-braces, and it took three attempts to place correctly.
A first version re-fired on every check when the cause flapped. A second
applied the gap only to the cause change, which left two holes: the first
message of an incident was unbounded, and a recovery reset the clock — so a
budget oscillating around the threshold fired, resolved and re-fired forever,
measured at sixteen messages in two hours. A third wrote the new cause into
state while suppressing the message, so the next check read "same cause,
already firing" and went silent permanently: the operator was told about a
drained window, never told the coordinator had gone down, and then handed a
`resolved` naming an incident that had never been announced.

The rule that survives all three: the state distinguishes the condition
*observed* from the condition *announced*, the gap is checked once on the way
to sending anything, and it survives a recovery. Recovery itself is never held
back — it can only follow a firing, so bounding the firing direction bounds
both — and if a message fails to send it is retried rather than dropped.

**A 429 hold is its own alert.** During one the window is deliberately
reported full — a hold is not a spending problem — so a check that judges only
the remaining budget reports perfect health while every caller is being
refused. That was the state this reached after fixing an unrelated defect, and
it is the worst reading the check can produce.

## Consequences

The dataset cannot answer "who is hammering this" or "what are people looking
up". Those are real operational questions and this deliberately gives them up.
The available responses to abuse remain the ones ADR 15 named — lower the
reservation, rotate the key, implement the OAuth provider — and none of them
needed a log of what strangers searched for.

Measurement is off unless a dataset is bound, and alerting is off unless a
webhook is set *and* KV is bound, because without KV there is nowhere to keep
the strike count that stops it crying wolf. Declining to alert is the honest
answer there; the guide says so rather than degrading quietly.

The heartbeat charts the whole window — 570 of 570 on a quiet deployment. It
records `-1` rather than `0` while the Durable Object is unreachable, so a
coordinator outage shows as a gap rather than as the budget collapsing, and it
is written as an `error` row rather than a `refused` one because a `peek`
turns nobody away.

**A degraded answer is recorded as one.** The composite tools absorb a failed
section rather than failing the whole snapshot, which is right for the caller
and was invisible to everyone else: a Companies House wobble that degraded
every answer on the server produced a dataset of clean `ok` rows.
`subrequestFailures` is the column that shows it, and it is the most likely
real incident here.

**A caller can write rows.** Every `POST /mcp` produces one, including ones
rejected for a bad origin or a bad body, so an unauthenticated client can
drive data points into the operator's dataset at request rate. Accepted: data
points are cheap, the row is what makes protocol-level abuse visible in the
first place, and the alternative — measuring only requests that got past the
gate — is the blindness this whole ADR is about. Cloudflare's own request
limits are the bound.

Analytics Engine columns are positional — `blob1..blob20`, `double1..double20`
— and inserting one in the middle does not migrate old rows, it reinterprets
them. Every query over the previous three months then silently reads the wrong
field. The layout is documented in `src/cloudflare/analytics-metrics.ts` and
asserted in `tests/metrics.test.ts`; new columns append, and a retired slot is
never reused.

**A refusal is counted separately from the outcome.** `outcome: 'refused'`
means the request failed *and* the limiter had turned something away; a
`screen_companies` run that skipped one company for budget and returned a
complete, honest table is `ok` with a non-zero refusal count. Collapsing the
two counted successful responses as rejections in the one query built to find
them.

**The alert reads the window, not a caller's share of it.** The scheduled
check peeks as an unseen client, and an unseen client is guaranteed a
reservation — 71 of 570 at the defaults — so its share cannot fall below that
until the window is nearly gone. Comparing it against 5% of the same 570 put
the threshold 2.5× underneath a floor the reading could not cross, and the
alert was silent through precisely the case it was written for: one caller
draining the window while every other caller is refused. `BudgetOutcome` now
carries `globalRemaining` and the threshold is compared against that.

Two defects were found by the tests rather than by review, both worth
recording because both were invisible to inspection. The pooled limiter is
constructed explicitly in `worker.ts` rather than by the client, so it never
received the recorder and the deployed path recorded no budget and no refusals
at all. And the flush was guarded only inside one sink implementation, so any
other sink throwing in the `finally` would have turned a good response into a
500 — measurement taking down the thing it measures.

**A `-32601` is a capability probe, not a fault.** This server registers tools
and nothing else, and many MCP clients ask for `resources/list` and
`prompts/list` unconditionally after `initialize`. Counting the SDK's "method
not found" answers as protocol errors put two or three error rows on every
client connection — into the single column an operator alerts on — and made the
error rate a function of how many clients had connected rather than of anything
being wrong.

**`durationMs` measures up to the last piece of I/O.** Workers freezes
`Date.now()` between I/O operations as a side-channel mitigation, so the CPU
spent after the final `fetch` is invisible and a request that did no I/O at all
records exactly zero. Neither test runtime emulates the freeze, so no test can
show it. Recorded here because the column looks like wall-clock time and is
not.

A later audit found a third of the same kind, and it is the reason the tests
now reuse one handler across invocations: the recorder could be hoisted out of
the request function — making it per-isolate, which is exactly the deployed
shape of `export default { fetch: createFetchHandler() }` — and the entire
suite still passed. The test meant to catch it built a fresh handler for each
call and so observed independence it had manufactured itself.
