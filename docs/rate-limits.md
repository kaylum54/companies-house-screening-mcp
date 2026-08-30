# Rate limits, the shared budget, and bringing your own key

Companies House allows **600 requests per five minutes, per API key**. Not per
user, not per machine, not per session — per key. Everything on this page
follows from that one sentence.

If you are *using* a hosted deployment, read [What you get](#what-you-get) and
[Bring your own key](#bring-your-own-key). If you are *running* one, read all
of it.

---

## What you get

A hosted deployment holds one Companies House key and serves everybody with
it. That is what makes it plug and play — no key to register, no config file,
no local install — and it means the 600 is a budget shared between you and
every other caller.

Three things make that workable rather than a race:

1. **The window is authoritative.** One counter, consulted by every request,
   wherever it runs. Not one counter per process hoping the others are quiet.
2. **You are guaranteed a share.** No one else's batch job can spend the
   window down to nothing while you are waiting.
3. **The cache is shared by everyone.** If somebody looked a company up in the
   last hour, your request costs nothing at all.

The third is the one that does the heavy lifting. A shared cache is why a
600-request ceiling supports far more than 600 lookups.

---

## The numbers

| | |
|---|---|
| Companies House limit | 600 requests / 5 minutes / key |
| Safety margin | 0.95 (`CH_RATE_SAFETY_MARGIN`) |
| **Effective window** | **570 requests / 5 minutes** |
| Your guaranteed share | 71 (`CH_CLIENT_RESERVATION`, default: effective ÷ 8) |
| Held back for a newcomer | 1 share (`CH_NEWCOMER_ALLOWANCE`) |

The margin exists because this server is not the only thing that can touch the
key — an operator running a script against the same credential would otherwise
push the shared window over the edge and everyone would see 429s.

### What things cost

| Call | Requests |
|---|---|
| `get_company`, `get_officers`, `find_company`, any primitive | 1 |
| `company_snapshot` | 4 — profile, officers, charges, insolvency |
| `screen_companies` | 3 per company — profile, charges, insolvency |
| `screen_companies` with `include_officers: true` | 4 per company |
| Anything already in the cache | **0** |

A 50-company screen is about 150 requests: roughly a quarter of the window in
one call. That is the number to keep in mind, and the reason fair sharing
exists at all.

---

## Fair shares

Every caller is guaranteed its reservation and may spend beyond it whenever
the window has room. The headroom held back scales with the callers who are
actually there, rather than being a fixed fraction reserved against a crowd
that may never arrive.

The rule: **you may burst until the window is down to one reservation for
every *other* active caller, plus one for a newcomer.**

With the defaults, that means:

| Active callers | One caller's ceiling | Of the 570 |
|---|---|---|
| 1 | 499 | 87.5% |
| 2 | 428 | 75% |
| 3 | 357 | 63% |
| 4 | 286 | 50% |
| 5 | 215 | 38% |
| 6 | 144 | 25% |
| 7 or more | 71 — the reservation floor | 12.5% |

A caller counts as *active* while it has at least one request inside the
five-minute window; once its last one ages out it stops being counted and
everyone else's ceiling rises again. The ceiling is on the window, so the
others' own spending comes out of the same figure.

Read the top row and the bottom row together, because between them they are
the whole design:

- **Alone, you get 499 of 570.** You are not made slower by machinery meant
  for a crowd. Exactly one reservation is held back, so that whoever arrives
  next is not met with an empty window.
- **From seven callers on, everyone is at their floor of 71.** The window
  divides evenly, nobody is starved, and nobody was ever refused something the
  window could have afforded. (The raw formula gives 73 at seven callers, but
  the reservation is guaranteed underneath it, so 71 is what you actually
  get.)

Every figure in this table is asserted by `tests/budget.test.ts`, so it cannot
quietly go stale — change the sharing rule and the test fails with this page's
numbers in the diff.

### The caller is identified by credential, then by address

A caller who brings a key is identified by that key. Everybody else is
identified by peer address. Both are hashed (SHA-256, first 16 hex characters)
before they are used as a name, so a log line or a Durable Object name never
carries a credential or a raw address.

Peer address is a **weak** partition and is used for budgeting only, never for
authorisation. A NAT groups strangers into one share; a determined caller can
move between addresses. The cost of getting it wrong is somebody sharing a
reservation they should have had to themselves — never somebody reading data
they should not see, because there is no per-caller data here to read. See
[ADR 15](adr/0015-authless-now-oauth-ready.md).

---

## Reading `meta`

Every tool result carries a `meta` block. Three of its fields are about
budget:

```json
"meta": {
  "cached": false,
  "stale": false,
  "rate_limit_remaining": 498,
  "rate_limit_resets_in_ms": 0,
  "licence": "OGL-v3.0"
}
```

| Field | Means |
|---|---|
| `cached` | The answer came from the shared cache and **cost no budget** |
| `age_seconds` | How old a cached answer is. Absent when the answer was live |
| `stale` | The upstream was unreachable and this is a cached answer served past its TTL. Check this before acting on anything time-sensitive |
| `rate_limit_remaining` | What **you** may still spend — your share, not the global window |
| `rate_limit_resets_in_ms` | How long until more is available. `0` means nothing is queued behind a wait |

`rate_limit_remaining` is the number to pace long runs against. It is *your*
view: on a busy server it will be lower than the global figure, and that is
the point — planning against the global number is how a caller commits to work
the limiter will then refuse.

**Worked example.** A single caller on a quiet server makes one `find_company`
call and sees `rate_limit_remaining: 498`. That is not a missing 72 requests:

```
effective window       floor(600 × 0.95)    = 570
reservation            floor(570 ÷ 8)       = 71
held back (0 others + 1 newcomer) × 71      = 71
your ceiling           max(71, 570 − 71)    = 499
after one request      499 − 1              = 498
```

For a composite call, watch it move by the call's real cost: a
`company_snapshot` against a cold cache drops it by 4.

---

## When the budget runs out

Three different things happen, deliberately, because they are three different
situations.

### 1. A single call waits

If budget will free up shortly, the request waits for it rather than failing.
The wait is bounded by `CH_MAX_WAIT_MS` — **60 seconds on a hosted
deployment**, and unbounded over stdio, where you are the only caller and
waiting for your own window is the correct behaviour.

### 2. A single call gives up

Past that bound you get a `RATE_LIMITED` error, which is data, not a stack
trace ([ADR 3](adr/0003-errors-are-data.md)):

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "This session has used its share of the shared Companies House budget for the current five-minute window.",
    "next_step": "Wait 42 seconds, or supply your own Companies House API key to get a budget of your own.",
    "retry_after_ms": 42000,
    "retryable": true
  }
}
```

Two things worth noticing. The message distinguishes **your share running
out** from **the whole window running out** — those are different problems
with different answers, and the second message reads "The Companies House rate
limit of 600 requests per five minutes has been reached." And `next_step`
points you at the fix rather than leaving you to find this page.

`retry_after_ms` is the time until the slot **you** need frees up, not until
some slot frees up. Those are different numbers under contention, and quoting
the wrong one is how you get "retry in 0 seconds" advice that helps nobody.

### 3. A batch comes back short — and says so

`screen_companies` sizes its batch against the budget *before* committing to
it, and returns everything it could not afford under `not_screened`, with the
reason and a retry time:

```json
"not_screened": [
  {
    "input": "GREGGS PLC",
    "reason": "Not enough rate-limit budget left in this five-minute window. Screening this company needs 3 requests. Retry in 47 seconds, or pass a shorter list."
  }
]
```

**The table is never quietly shorter than the list you sent.** This is the
whole of [ADR 8](adr/0008-partial-results-and-budget-honesty.md): a screening
tool that silently drops rows is worse than one that refuses, because the
missing supplier looks exactly like a clean supplier.

### Two failure modes worth knowing

- **Companies House says 429.** The server records the `Retry-After` and holds
  *all* traffic on that key until it passes, rather than continuing to knock.
  One caller's overrun does not become everybody's ban.
- **The window cannot be reached.** If the Durable Object backing the counter
  is unavailable, requests fail closed rather than spending the key blind — a
  server that guesses at its own rate limit is how a key gets suspended. The
  error is deliberately **`UPSTREAM_UNAVAILABLE`, not `RATE_LIMITED`**: you
  have not exceeded anything, and sending you away to wait for a window reset
  would be a confident wrong diagnosis of somebody else's outage. The same
  reasoning applies to `screen_companies`, which returns one honest failure
  rather than fifty rows each blaming your budget.

---

## Bring your own key

If the shared budget is too tight, supply your own and get a private window.

### Get a key

Register at
[developer.company-information.service.gov.uk](https://developer.company-information.service.gov.uk/),
create an application, and take the **REST API key** from it — not a streaming
key. Registration is free at the time of writing (August 2026); the portal is
the authority on current terms.

### Send it

One header, on every request:

```
X-Companies-House-Api-Key: your_key_here
```

Claude Code:

```bash
claude mcp add --transport http companies-house https://your-server/mcp \
  --header "X-Companies-House-Api-Key: your_key_here"
```

curl, to check it works:

```bash
curl -s -X POST https://your-server/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-Companies-House-Api-Key: your_key_here' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"find_company","arguments":{"query":"Greggs"}}}'
```

**How to tell it worked:** make an uncached call with the header and without
it, and compare `rate_limit_remaining`. With your own key it starts from the
full 570 — no fair-share ceiling — so the number will be *higher* than the
pooled one. A search is a good test because it can never be cache-served.

### What changes, and what does not

| | Pooled key | Your own key |
|---|---|---|
| Budget | Shared, fair-shared, 71 guaranteed | **Yours alone, all 570** |
| Fair sharing | On | **Off** — there is nobody to be fair to |
| Cache | Shared | **Still shared** |
| Tools, results, everything else | Identical | Identical |

The cache stays shared on purpose. The register is public and a company
profile fetched with your key is byte-for-byte the profile fetched with
anyone's, so partitioning the cache would multiply upstream cost for no
privacy gain — there is no private data in it to leak. A private budget goes
further against a warm cache than a cold one.

### What happens to your key

- Read from the header and used to build the upstream `Authorization` header.
  Nothing else.
- **Never logged, never returned in a tool result, and never reaches the
  model.** Where an identity has to be named — a log line, a Durable Object
  name — it is named by a truncated SHA-256 fingerprint instead.
- **It is not part of any cache key.** Cache entries are keyed on the HTTP
  method and URL alone, which is both why your key cannot leak through the
  cache and why the cache can be shared across keys at all.
- **A malformed value is treated as absent.** Anything with whitespace, a
  control character, or over 256 characters is dropped and you land in the
  shared pool. That is deliberate: the value ends up in a header, and a header
  value carrying a newline is how header injection starts.
- **Supplying the deployment's own key puts you in the pool**, not on a second
  private window. Companies House meters the key, so two windows on one
  credential would let the server spend roughly twice what it has.

### If your client cannot send headers

Not every MCP client can. Claude Code can (`--header`). claude.ai's custom
connector UI appears not to as of August 2026 — that comes from issue reports
rather than published documentation, so check rather than assume, in either
direction.

Where a client cannot, run the server locally over stdio. You get your own
budget, your own cache, and no shared ceiling at all. See the
[README](../README.md#local--stdio).

---

## For operators

### Tuning

| Variable | Default | When to change it |
|---|---|---|
| `CH_RATE_LIMIT` | `600` | Lower it if the key is shared with something else — a cron job, another app |
| `CH_RATE_SAFETY_MARGIN` | `0.95` | Lower it if you touch the key outside this server |
| `CH_CLIENT_RESERVATION` | effective ÷ 8 (71) | See below |
| `CH_NEWCOMER_ALLOWANCE` | `1` | Raise it if callers arrive in bursts and being met with an empty window matters more than throughput |
| `CH_MAX_TRACKED_CLIENTS` | `10000` | Backstop only. An identity exists only while it holds a timestamp in the window, and the window holds at most the effective limit of them, so the real bound is 570 at the defaults and this never binds |
| `CH_ALLOW_CLIENT_KEYS` | `true` | Set `false` to refuse caller-supplied keys entirely |
| `CH_MAX_WAIT_MS` | `60000` hosted | How long a request waits before `RATE_LIMITED` |
| `CH_TRUST_PROXY_HEADERS` | `false` | **Only** behind a proxy you control — see below |

Choosing a reservation:

- **A few heavy users** doing batch screens: raise it, so a whole run fits in
  one caller's share. At 71 a caller gets ~23 companies before it is relying
  on headroom.
- **Many light users** doing single lookups: lower it, so more callers fit
  before everyone hits the floor. The window divides into `570 ÷ reservation`
  guaranteed callers.

The reservation is a **floor under everyone else, not a ceiling on anyone** —
a caller exceeds it freely whenever the window has room.

### Proxy headers

If a reverse proxy sits in front, set `CH_TRUST_PROXY_HEADERS=true`. Otherwise
every caller arrives with the proxy's address, collapses into one identity,
and the whole world shares a single reservation.

Do **not** set it when the server is directly reachable. `X-Forwarded-For` is
then just a header the caller typed, and a client varying it per request would
mint a fresh reservation every time and defeat fair sharing entirely. On
Cloudflare, `CF-Connecting-IP` is set by the platform and any client-supplied
copy is stripped, so the Worker trusts it without needing this flag.

### Which deployment gets the budget right

| | Correct under load? |
|---|---|
| **stdio** | Yes — one process, one user, one key |
| **Node HTTP, one instance** | Yes |
| **Node HTTP, several instances** | **No.** Each instance counts its own window. Run one, or use Workers |
| **Cloudflare Workers** | Yes — a Durable Object is single-threaded and globally unique per key, so "check the window and take a slot" is genuinely atomic |

This is the reason the Workers deployment exists, and it is covered by tests
that run inside `workerd` rather than against a stand-in. See
[docs/deployment.md](deployment.md).

### Is pooling one key even allowed?

Checked in August 2026: the Companies House developer terms **do not address
it**. There is no published usage policy specific to the public data API that
says pooling one registered key behind a shared service is permitted, and
nothing that says it is prohibited. Those terms do prohibit other things by
name, so the reading taken here is that a silence in that company is not a
prohibition — but unaddressed is not approved, and it is your account and your
key that carry the consequence. Ask Companies House support if you want
certainty rather than a reading.

If it ever turns out to be disallowed, nothing about this design is wasted:
set `CH_ALLOW_CLIENT_KEYS=true` (the default) and require the header, and
every caller is on their own credential with the same code path.

### The ceiling is real

No amount of engineering raises 600 per five minutes. Only more keys do. If
your deployment is busy, the honest answers are: lean on the shared cache,
point heavy users at [bring your own key](#bring-your-own-key), and tell
people to self-host over stdio.

---

## Further reading

- [ADR 13 — one key, a shared budget, and fair shares within it](adr/0013-one-key-shared-budget-fair-shares.md) — why it is built this way
- [ADR 8 — partial results and budget honesty](adr/0008-partial-results-and-budget-honesty.md) — why a short table always says so
- [ADR 2 — the sliding-window limiter](adr/0002-sliding-window-rate-limiter.md) — the original single-process design and what was wrong with it
- [ADR 15 — authless now, OAuth-ready](adr/0015-authless-now-oauth-ready.md) — what identity does and does not mean here
- [docs/deployment.md](deployment.md) — running one
- [docs/observability.md](observability.md) — seeing what a running one is doing
- [ADR 16 — measure volume and outcome, never content](adr/0016-measure-volume-not-content.md) — what the analytics deliberately cannot tell you
