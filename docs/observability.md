# Knowing what your deployment is doing

An authless hosted server spends one API key on behalf of strangers. Every way
that goes wrong is silent by default: the key gets throttled, one caller
drains the window every five minutes, the Durable Object has a bad hour, the
cache stops hitting and upstream cost triples. You find out by trying it.

This page turns that on. Two parts, and the first is worth having on its own:

1. **Measurement** — one row per request in Workers Analytics Engine, queried
   with SQL.
2. **Alerting** — a scheduled check that tells you when the window is spent or
   the limiter is unreachable.

Both are optional and both are off until you bind something.

> **What is never recorded:** company numbers, search queries, caller
> identifiers of any kind, API keys, URLs, request bodies. What a user looks up
> is their commercial business, and this records volume and outcome only. The
> guarantee is structural rather than careful — see
> [ADR 16](adr/0016-measure-volume-not-content.md).

---

## Part 1 — measurement

### Turn it on

`wrangler.toml` already declares the dataset:

```toml
[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "companies_house_mcp"
```

```bash
npx wrangler deploy
```

That is the whole setup. Nothing else is needed, no token, no dashboard step.
Remove the block and the Worker runs exactly as before and measures nothing.

### What one row contains

One data point per invocation — never one per upstream call, because the
platform accepts 250 `writeDataPoint` calls per invocation and a fifty-company
`screen_companies` run makes roughly 150 upstream requests.

| Column | Meaning |
|---|---|
| `index1` | Tool name. Also the sampling key, so a flood of one tool cannot hide the others |
| `blob1` | Outcome: `ok`, `error` or `refused` |
| `blob2` | Error code, when there was one |
| `blob3` | Refusal cause: `none`, `client`, `global`, `penalty`, `unavailable` |
| `blob4` | Deployed version, for before-and-after comparisons |
| `double1` | Upstream requests — what this cost the key |
| `double2` | Cache hits |
| `double3` | Cache misses |
| `double4` | Upstream retries |
| `double5` | Upstream 429s from Companies House |
| `double6` | Stale answers served |
| `double7` | Budget remaining at the end, or `-1` if never consulted |
| `double8` | Budget limit, or `-1` |
| `double9` | Duration in milliseconds |
| `double10` | `1` if the caller brought their own key |

**Columns are positional and permanent.** Analytics Engine stores these as
`blob1..blob20` and `double1..double20`; the names above exist only in
`src/cloudflare/analytics-metrics.ts`. Inserting a column in the middle does
not migrate old rows, it reinterprets them — every query over the previous
three months then silently reads the wrong field. Append at the end, never
reorder. `tests/metrics.test.ts` asserts the layout so this cannot happen by
accident.

Rows are retained for **three months**.

### Querying

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -d "SELECT ..."
```

The token needs **Account Analytics: Read**, and nothing else. Create it under
My Profile → API Tokens. **It belongs on your machine, not in the Worker** —
nothing in the deployment reads analytics back, which is why the alerting in
part 2 reads the Durable Object instead.

**Always multiply by `_sample_interval`.** Analytics Engine samples under
load, and a plain `COUNT(*)` undercounts silently once it does. `SUM(_sample_interval)`
is the correct row count; `SUM(_sample_interval * doubleN)` is the correct
total.

### The five questions worth asking

**Is it being used, and for what?**

```sql
SELECT index1 AS tool,
       SUM(_sample_interval) AS calls
FROM companies_house_mcp
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY tool
ORDER BY calls DESC
```

**Is the cache earning its keep?** This is the number that decides whether a
600-request ceiling supports your traffic.

```sql
SELECT SUM(_sample_interval * double2) AS hits,
       SUM(_sample_interval * double3) AS misses,
       SUM(_sample_interval * double2)
         / (SUM(_sample_interval * double2) + SUM(_sample_interval * double3)) AS hit_rate
FROM companies_house_mcp
WHERE timestamp > NOW() - INTERVAL '1' DAY
```

**Is anybody being refused, and why?** The four causes are four different
problems: `client` means fair sharing is biting and somebody should bring
their own key, `global` means the window is genuinely spent, `penalty` means
Companies House returned a 429, and `unavailable` means the Durable Object
could not be reached and this is not a budget problem at all.

```sql
SELECT blob3 AS cause,
       SUM(_sample_interval) AS refusals
FROM companies_house_mcp
WHERE timestamp > NOW() - INTERVAL '1' DAY
  AND blob1 = 'refused'
GROUP BY cause
ORDER BY refusals DESC
```

**What is this costing the key?**

```sql
SELECT SUM(_sample_interval * double1) AS upstream_requests,
       SUM(_sample_interval * double5) AS throttled
FROM companies_house_mcp
WHERE timestamp > NOW() - INTERVAL '1' DAY
```

Any non-zero `throttled` means the key went over its limit — the safety margin
was not enough, and `CH_RATE_SAFETY_MARGIN` should come down.

**How close to the edge is it running?** The scheduled check writes a
`heartbeat` row every five minutes whether or not anybody called, so this
charts even through quiet periods.

```sql
SELECT timestamp,
       double7 AS budget_remaining,
       double8 AS budget_limit
FROM companies_house_mcp
WHERE timestamp > NOW() - INTERVAL '1' DAY
  AND index1 = 'heartbeat'
ORDER BY timestamp
```

---

## Part 2 — alerting

### The free half: Cloudflare's own notifications

Do this first, because it costs nothing and needs no code. In the Cloudflare
dashboard: **Notifications → Add → Workers → error rate**, pointed at your
email. That covers "is it up", which the rest of this page does not.

### The useful half: a scheduled check

`wrangler.toml` already declares the trigger:

```toml
[triggers]
crons = ["*/5 * * * *"]
```

Every five minutes — one check per rate-limit window. The run reads the
Durable Object, writes a heartbeat row, and decides whether to alert.

**It reads the Durable Object, not the analytics.** The obvious design queries
the SQL API on a schedule, which means an account API token living inside an
authless Worker anybody on the internet can reach: a credential added to the
most exposed component in the system in order to watch it. The window is
already held authoritatively by the Durable Object, so there is no read token
anywhere in the deployment.

**It uses `peek`, never `acquire`.** A check that took a slot would consume
288 requests a day of the allowance it exists to protect.

### Point it somewhere

```bash
npx wrangler secret put CH_ALERT_WEBHOOK_URL
```

A secret, not a var — it is a capability URL and belongs out of the repository
and out of the dashboard's plain-text vars. **Must be `https`**; anything else
is refused and nothing is sent. Slack, Discord and most incident tools accept
a JSON POST directly.

**KV must be bound too.** The strike count that stops this crying wolf is kept
there, and without it the check declines to alert rather than firing on every
blip. That is deliberate: alerting that fires on a busy afternoon gets muted,
and a muted channel is worse than none because it is still believed to work.

### What arrives

```json
{
  "state": "firing",
  "reason": "budget_exhausted",
  "text": "The shared Companies House budget is nearly spent and callers are being refused. Budget 12 of 570.",
  "budgetRemaining": 12,
  "budgetLimit": 570,
  "at": "2026-08-25T18:45:00.000Z"
}
```

Two numbers and a state. No caller, no company, no key.

| Condition | Fires when |
|---|---|
| `budget_exhausted` | A newcomer would get under 5% of the window, twice in a row |
| `limiter_unavailable` | The Durable Object could not be reached, twice in a row |

**Two consecutive checks, not one.** A busy five minutes legitimately drains
the window; that is the design working, not a fault. Two means it failed to
recover across a full period.

**It repeats nothing.** While a problem continues you hear nothing further.
When it clears you get one `"state": "resolved"` message and the count resets.

### Reading the budget figure

On a quiet deployment the heartbeat reports **499 of 570**, not 570. That is
correct: the check reads the pooled window as an arriving caller would see it,
so the figure answers *is the next person through the door going to be
refused* rather than *what is left in total*. See
[rate-limits.md](rate-limits.md#fair-shares) for where 499 comes from.

---

## Costs

Analytics Engine is included with Workers Paid, which this deployment already
requires for the subrequest ceiling. One row per request and one per
five-minute heartbeat is a small volume by its standards. Cron Triggers are
free. The only thing that could surprise you is query volume against the SQL
API, which is a thing you do by hand.

## Turning it all off

Delete the `[[analytics_engine_datasets]]` block to stop measuring, delete
`[triggers]` to stop the scheduled check, and
`npx wrangler secret delete CH_ALERT_WEBHOOK_URL` to stop alerting while
keeping the heartbeat. Each is independent and none of them is load-bearing:
the server serves requests identically with all three gone.

## A note on sources

The binding syntax and the platform limits quoted here were read out of the
`wrangler` config schema and Miniflare's implementation in this repository's
own `node_modules`, so they match the version that will run. The SQL API
endpoint and the `_sample_interval` convention come from Cloudflare's
published documentation, which this project's build environment cannot reach
to quote directly — check them against the current docs if a query behaves
unexpectedly.
