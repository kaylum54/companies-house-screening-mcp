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

Recorded, per request: the tool called, whether it succeeded, failed or was
refused, the error code or refusal cause, how many upstream calls it made, how
many answers came from cache, retries, upstream 429s, stale answers served,
the budget at the end, whether the caller brought their own key, and the
duration.

Deliberately **not** recorded:

- **Company numbers and search queries.** The single most sensitive thing
  flowing through this server. Nothing operational needs them: "how many
  requests" and "how expensive" are answerable without ever knowing which
  company.
- **Any per-caller identifier**, including the truncated fingerprint the
  limiter already computes. A hashed IP address is still pseudonymous personal
  data, and the only question that wanted it — how many callers are competing —
  is answered by a count.
- **API keys, URLs, request bodies, headers.**

**The rule is enforced by the shape of the interface, not by care.**
`MetricsRecorder` exposes counters and two label methods, rather than a
general `record(name, value)`. Both labels pass through a sanitiser that keeps
only `[a-z0-9_]` and truncates at 48 characters, so a value that should never
have been passed emits a mangled token instead of a leak. The two call sites
take a tool name and an error code, both from closed sets in this codebase;
the sanitiser is what holds when a change six months from now is careless.

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

**Alerting waits for two consecutive bad checks.** A busy five minutes
legitimately drains the window — that is the design working. Alerting that
fires on it gets muted, and a muted channel is worse than none because it is
still believed to work. Recovery is reported exactly once.

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

The scheduled run reads the pooled window as an unknown caller would see it,
so its figure is what an arriving caller could spend rather than the raw
global remainder — 499 of 570 on a quiet deployment, not 570. That is the
number worth alerting on, because it answers whether the next person through
the door will be refused, and a share is bounded by what is globally available
so it can only fall near zero when the window genuinely has.

Analytics Engine columns are positional — `blob1..blob20`, `double1..double20`
— and inserting one in the middle does not migrate old rows, it reinterprets
them. Every query over the previous three months then silently reads the wrong
field. The layout is documented in `src/cloudflare/analytics-metrics.ts` and
asserted in `tests/metrics.test.ts`; new columns append, and a retired slot is
never reused.

Two defects were found by the tests rather than by review, both worth
recording because both were invisible to inspection. The pooled limiter is
constructed explicitly in `worker.ts` rather than by the client, so it never
received the recorder and the deployed path recorded no budget and no refusals
at all. And the flush was guarded only inside one sink implementation, so any
other sink throwing in the `finally` would have turned a good response into a
500 — measurement taking down the thing it measures.
