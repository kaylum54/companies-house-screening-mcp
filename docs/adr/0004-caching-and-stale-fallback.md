# 4. Two-layer cache, TTL by resource, stale on failure

- **Status:** accepted
- **Date:** 2026-08-20

## Context

The cache is not an optimisation here, it is a feature that makes the headline
tool possible. `screen_companies` over thirty suppliers makes four calls each:
120 requests against a budget of 600 per five minutes. Run it twice in an
afternoon and the second run starts hitting 429s.

Company data also barely moves. A profile changes when something is filed,
which for most companies is twice a year.

Separately, MCP hosts restart servers constantly — every reconnect is a fresh
process — so an in-memory-only cache would be thrown away several times an
hour in normal use.

## Decision

**Two layers.** An in-memory map for the current process, and a disk layer
underneath it so that a restart does not discard the day's work. Disk writes
go to a temporary file and are renamed into place, so a crash mid-write cannot
leave a truncated file that later parses as valid JSON.

**TTL varies by resource.** Filing history gets six hours because it is the
section that changes when anything happens. Profiles, charges, PSC and
insolvency get twenty-four. Search gets one hour: a newly incorporated company
appearing an hour late is harmless, a missed charge is not.

**Conditional revalidation only on a real HTTP `ETag`.** Companies House JSON
payloads contain an `etag` field. That is a resource-version marker in the
body, not an HTTP validator, and sending it as `If-None-Match` would produce
wrong results silently. Where no HTTP ETag comes back, the cache degrades to
plain TTL, which is the common case today.

**Expired entries are served when the upstream fails.** If Companies House
returns 503 and we hold an expired copy, the copy is returned with
`meta.stale` set. An hour-old answer, labelled as an hour old, beats no answer.

This applies to retryable failures only. A 404 is a real answer, not an
outage; papering over it with a cached copy would be worse than failing.

**A corrupt cache file is never a request failure.** Unreadable or
wrongly-shaped entries are logged at debug and treated as a miss.

## Consequences

Data can be up to twenty-four hours old, and a caller cannot always tell from
the payload. This is mitigated but not solved by `meta.cached` and
`meta.stale`; tools that report on time-sensitive fields should surface the
age, and `bypassCache` exists for callers that genuinely need this second's
answer.

The disk cache grows without bound. There is no eviction beyond the in-memory
ceiling. At the size these payloads run to that is acceptable for now, and it
is worth revisiting before anyone points this at a bulk workload.
