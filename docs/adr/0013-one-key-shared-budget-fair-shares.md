# 13. One key behind the server, a shared budget, and fair shares within it

- **Status:** accepted
- **Date:** 2026-08-24

## Context

The hosted deployment holds the operator's Companies House API key so that
users do not need one. That is what makes it plug and play, and it converts an
accounting bug into a capacity problem.

The accounting bug (ADR 2): the limiter counted requests in one process, while
Companies House meters per key. Five processes on one key believed they
collectively owned five windows. The 0.95 safety margin was an honest
mitigation when the unseen traffic was a second editor window, and no margin
can make an unshared counter correct when the unseen traffic is every other
user.

The capacity problem is arithmetic. Companies House allows 600 requests per
five minutes per key. `company_snapshot` costs 4 requests; `screen_companies`
costs 3 per company by default, so a 50-company run costs about 150. Four
concurrent batch screens exhaust the entire global window. Without a per-caller
rule, the first person to paste in a supplier list takes the budget and
everyone else sees nothing.

## Decision

**The window is authoritative, and shared by everyone on the same key.** The
arithmetic moved into `SlidingWindowBudget`, which is pure: it takes `now` as
an argument, owns no clock and does no I/O. That is what lets identical code
run in one Node process and inside a Cloudflare Durable Object, which is
single-threaded and globally unique per key and therefore makes "check the
window and take a slot" atomic rather than atomic-if-nobody-scaled-out.
Writing the algorithm once and hosting it twice is the only way the two
answers stay the same.

**The credential is the unit of partition, because that is what Companies
House meters.** Sessions on the pooled key share one window. A session that
brought its own key gets a window of its own: it cannot be starved by the
pool, and cannot starve it.

**The cache is shared by everyone, always — including across keys.** The
register is public, and a profile fetched with one key is byte-for-byte the
profile fetched with another. Partitioning the cache per caller would multiply
upstream cost for no privacy gain, because there is no private data in it to
leak. This is most of the economic argument for hosting at all: the tenth
person to screen a supplier should not pay for the first person's request.

**Each caller has a reservation it can always spend.** Within the pooled
window every client is guaranteed a share — an eighth of the effective window
by default, 71 of 570 — and may exceed it only while the window has room.

**The headroom held back scales with the callers who are actually there.** The
first design used a fixed burst threshold and stranded a quarter of the budget
against a crowd that might never arrive. Instead, a caller may burst until the
window is down to one reservation for every *other* currently-active client
plus one for a newcomer. With the defaults that leaves a lone caller 499 of the
570-request effective window — all of it bar the one reservation held back —
while a newcomer is still guaranteed its share on arrival.

**Overflow degrades into the shape ADR 8 already defines.** Work that does not
fit comes back under `not_screened` with a real reset time. Nothing is dropped
quietly.

**A caller may bring their own key** via `X-Companies-House-Api-Key`, and gets
a private window with fair sharing switched off — slicing a private budget
into shares for callers who cannot reach it would only make it smaller.

## Consequences

The hosted server has a hard ceiling of 600 requests per five minutes, total,
across every user. No amount of engineering raises it; only more keys do. The
honest consequences are that heavy users should bring their own key, and that
the shared cache is what makes the ceiling tolerable.

Fair sharing needs a principal to be fair between, and an authless server has
only the peer address. That is a weak partition — a NAT groups strangers, and
anyone determined can move — and it is used for budgeting only, never for
authorisation. See ADR 15.

`peek` and `acquire` must agree exactly, because `screen_companies` sizes its
batch against `peek`. The first implementation approximated the admission rule
in `peek` instead of deriving from it, and promised rows the limiter then
refused — the precise silent shortfall ADR 8 exists to prevent. There is now a
test asserting that what `peek` promises is what `acquire` grants, in both the
quiet and contended cases.

Bringing your own key requires setting an HTTP header. Clients differ on
whether they can: Claude Code takes `--header`, and at the time of writing
(August 2026) claude.ai's custom connector UI appears not to offer it — that
last point comes from an issue report against the connector UI rather than from
published documentation, so it is worth re-checking rather than treating as
settled. Where a client cannot send the header, the answer is to run the server
over stdio, which has always worked and is another reason ADR 12 kept it.
