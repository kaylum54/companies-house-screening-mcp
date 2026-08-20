# 2. A sliding window rate limiter, with a safety margin

- **Status:** accepted
- **Date:** 2026-08-20

## Context

Companies House publishes a limit of 600 requests per five-minute window per
API key. Exceeding it returns 429 for every further request until the window
resets.

Two other facts shape the design:

1. The service also returns `X-Ratelimit-Limit`, `X-Ratelimit-Remain` and
   `X-Ratelimit-Reset` headers. None of them appear in the published
   documentation.
2. The budget belongs to the key, not to this process. The same key may be in
   use by a scheduled job, a second editor window, or a colleague.

## Decision

**A sliding window over recorded request timestamps**, not a token bucket.

A bucket refilling at two per second would smooth traffic and would also make
`screen_companies` over thirty suppliers take a minute for no reason. The real
constraint permits bursts, so the limiter permits bursts.

**A safety margin, defaulting to 0.95.** This process will use 570 of the 600.
Running to exactly the documented ceiling guarantees a 429 for whatever else
shares the key, and the failure lands on the other process rather than this
one, which makes it hard to diagnose.

**Server headers are a correction, never the source of truth.** They tighten
a budget that is already tracked locally. If they disappear tomorrow, nothing
changes. A hint arriving without a reset time expires one window after it was
recorded — otherwise a `remain: 0` header with no `reset` header deadlocks the
process on the strength of a field that is not even documented.

**Acquisition is serialised.** Ten concurrent callers each reading a budget of
one, all deciding they may proceed, is the exact failure the limiter exists to
prevent, and it only shows up under the concurrency that `company_snapshot`
introduces.

## Consequences

The limiter is more conservative than the documented budget, so a very heavy
run is marginally slower than it strictly has to be. That is the intended
trade: 30 requests of headroom against an outage that affects a process nobody
is looking at.

Because the window is sliding rather than fixed, the limiter is stricter than
the server around a window boundary. It will occasionally wait when the server
would have allowed the call. This is accepted; the reverse error is worse.
