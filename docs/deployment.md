# Deploying this server

Three ways to run it. They are not alternatives to each other so much as
answers to different questions.

| | Who it is for | What it costs | Budget |
|---|---|---|---|
| **stdio** (`npx`, Docker) | One person, on their own machine | Nothing | Your own key, your own 600/5min |
| **Node HTTP** | A team, one deployment | A small always-on host | One key shared, fair shares within it |
| **Cloudflare Workers** | Public or team, correct under scale-out | Workers Paid, $5/mo | Same, with the window in a Durable Object |

stdio is still the right answer for a single user and is not deprecated. See
[ADR 12](adr/0012-remote-transport-alongside-stdio.md).

---

## 1. stdio

Unchanged. See the README. Nothing below applies to it.

---

## 2. Node over HTTP

```bash
npm install -g companies-house-screening-mcp
COMPANIES_HOUSE_API_KEY=your_key \
CH_HTTP_HOST=0.0.0.0 \
CH_HTTP_PORT=8787 \
companies-house-screening-mcp-http
```

The MCP endpoint is `POST /mcp`. There is a `GET /health` that returns
`{"status":"ok","version":"..."}` and deliberately says nothing about the
budget or the key.

**It binds to `127.0.0.1` unless you say otherwise.** A server that binds
every interface the moment it starts is one command away from being on the
office network, and this one holds an API key. Set `CH_HTTP_HOST=0.0.0.0` when
you mean it, and put it behind TLS.

### Correctness requires exactly one instance

The Node deployment holds the rate-limit window in process memory. That is
authoritative **only if there is one process**. Two replicas behind a load
balancer means two windows and the original bug back again, doubled.

So either run a single instance (Fly.io, Railway, Render, a VPS, Cloud Run
pinned to `max-instances=1`), or use the Cloudflare deployment, where the
window lives in a Durable Object and scale-out is safe by construction.

---

## 3. Cloudflare Workers

The window lives in a Durable Object: single-threaded, globally unique per
key, so "check the budget and take a slot" is atomic across every isolate.
This is the only deployment here that is correct under autoscaling without
being told to stay small.

### This needs the Workers Paid plan ($5/mo)

Not for Durable Objects — SQLite-backed ones are on the free plan. For
subrequests. A single `screen_companies` over fifty companies makes roughly
150 calls to Companies House **in one invocation**, and the free plan allows
50 external subrequests per invocation. Your headline feature would fail on
the free tier.

### Setup

```bash
# 1. Cache namespace
npx wrangler kv namespace create CACHE
#    put the printed id into wrangler.toml

# 2. The API key is a secret, not a var
npx wrangler secret put COMPANIES_HOUSE_API_KEY

# 3. Deploy
npx wrangler deploy
```

Your endpoint is `https://<worker>.<subdomain>.workers.dev/mcp`.

`wrangler.toml` already sets `nodejs_compat` (needed for `node:crypto`, the one
Node built-in the portable core uses — see
[ADR 14](adr/0014-runtime-portable-core.md)) and raises the subrequest limit
explicitly rather than relying on the default.

Two things worth knowing about `[limits]`: it applies only on the Standard
Usage Model, and it is enforced when deployed to Cloudflare's network rather
than in `wrangler dev`. So a local run will not reproduce a subrequest ceiling
either way. Note also that Wrangler does not reject unknown keys inside
`[limits]`, so a typo there fails silently — the field names are `subrequests`
and `cpu_ms`.

**Do not put the API key in `[vars]`.** Vars are plain text in the dashboard
and in your repository. Use `wrangler secret put`.

### Knowing what it is doing once it is live

An authless endpoint you cannot observe is the one thing left that can bite
you quietly: the key gets throttled, one caller drains the window, or the
Durable Object has a bad hour, and each of those is invisible until somebody
complains. `wrangler.toml` already declares an Analytics Engine dataset and a
five-minute scheduled check — see
[**observability.md**](observability.md) for what is recorded, the SQL to
query it, and how to point alerts at a webhook.

Worth doing first, because it is free and needs no code: Cloudflare dashboard
→ Notifications → Add → Workers → error rate, pointed at your email.

### Before you deploy a change

```bash
npm test            # the logic, under Node
npm run test:workers  # the deployed handler, under workerd
```

Both, not either. The two runtimes disagree in ways that only show up in the
second: a `globalThis.fetch` stored detached works under Node and throws
`TypeError: Illegal invocation` on workerd, which once meant 400-odd passing
tests and a deployed Worker where every tool call failed. `npm run
test:workers` runs the real handler inside workerd against the bindings this
file's `wrangler.toml` declares, with only Companies House replaced. It needs
no key, no network and no Cloudflare account.

It is not a substitute for `npx wrangler dev`, and neither is a substitute for
the health check below. The suite supplies `COMPANIES_HOUSE_API_KEY` itself and
Miniflare invents local KV and Durable Object storage whatever ids are in
`wrangler.toml` — so a secret you never ran `wrangler secret put` for, and a
namespace id you never replaced, both still go green here and fail on
Cloudflare.

---

## Connecting a client

### claude.ai (web and mobile)

Settings → Connectors → Add custom connector → paste your `/mcp` URL. No
authentication needed.

### Claude Code

```bash
claude mcp add --transport http companies-house https://your-server/mcp
```

### Anything else

Point it at the `/mcp` URL with the Streamable HTTP transport.

---

## Bring your own key

> Callers should be pointed at [rate-limits.md](rate-limits.md), which covers
> this from their side: getting a key, sending it, checking it took effect,
> and what the shared budget gives them if they do not. The summary below is
> what an operator needs.

The shared budget is 600 requests per five minutes for *everyone using your
server combined*. A caller who finds that tight can supply their own key and
get a private window:

```
X-Companies-House-Api-Key: their_own_key
```

Send it on the initialize request — every client that can set headers sets
them on all requests, so in practice this just works. The caller then gets
their own 600/5min, is not subject to fair-share limits, and still benefits
from the shared cache, because register data is public and identical whoever
fetched it.

**Not every client can send a custom header.** Claude Code can
(`--header "X-Companies-House-Api-Key: ..."`); claude.ai's connector UI appears
not to, as of August 2026 — that comes from issue reports rather than published
documentation, so check before relying on it either way. Where a client cannot,
the answer is to run the server over stdio, which gives that user their own
budget and has always worked.

The key is read once, never logged, never cached, never returned in a tool
result, and never reaches the model. A malformed value is treated as absent
rather than passed into an auth header.

---

## Configuration

Everything is environment variables. Only the first is required. The table
below covers the ones that matter to a hosted deployment; `.env.example` in the
repository lists the full set, including the HTTP-client tuning
(`CH_API_BASE_URL`, `CH_TIMEOUT_MS`, `CH_MAX_RETRIES`, `CH_RETRY_BASE_MS`,
`CH_RATE_WINDOW_MS`, `CH_RATE_SAFETY_MARGIN`, `CH_CACHE_DIR`) that applies to
every transport alike.

| Variable | Default | Notes |
|---|---|---|
| `COMPANIES_HOUSE_API_KEY` | — | Required. A secret. |
| `CH_HTTP_HOST` | `127.0.0.1` | Set to `0.0.0.0` to accept external connections |
| `CH_HTTP_PORT` | `8787` | |
| `CH_ALLOWED_ORIGINS` | empty | Comma-separated. Only affects browsers; MCP clients send no Origin |
| `CH_MAX_REQUEST_BYTES` | `1048576` | Body ceiling. Enforced on both entry points |
| `CH_CLIENT_RESERVATION` | effective limit ÷ 8 | Requests each caller is always guaranteed |
| `CH_NEWCOMER_ALLOWANCE` | `1` | How many unseen callers to hold a reservation for |
| `CH_MAX_TRACKED_CLIENTS` | `10000` | Backstop only. Identities are already bounded by the window itself — an identity exists only while it holds a timestamp, and the window holds at most `CH_RATE_LIMIT` × margin of them, so the real ceiling is 570 at the defaults and this eviction never runs |
| `CH_ALLOW_CLIENT_KEYS` | `true` | Whether callers may bring their own key |
| `CH_ALERT_WEBHOOK_URL` | — | **Workers only.** A secret, not a var. `https` only. Where the scheduled check sends alerts; unset means none. See [observability.md](observability.md) |
| `CH_TRUST_PROXY_HEADERS` | `false` | Believe `X-Forwarded-For` / `CF-Connecting-IP` when identifying callers. Turn on **only** behind a proxy you control |
| `CH_MAX_SESSIONS` | `1000` | Open sessions kept before the least recently used is evicted |
| `CH_SESSION_IDLE_MS` | `1800000` | How long a session may idle before being swept |
| `CH_MAX_WAIT_MS` | `60000` (hosted only) | How long a request waits for budget before `RATE_LIMITED`. Unset on stdio, which waits for the window |
| `CH_RATE_LIMIT` | `600` | Lower it if the key is shared with something else |

> Changing `CH_RATE_LIMIT`, `CH_RATE_SAFETY_MARGIN` or `CH_CLIENT_RESERVATION`
> on Workers does not take effect immediately. The Durable Object reads them
> on first contact and keeps them for its lifetime, so a busy pooled key can
> run on the old numbers for some time after a deploy.
| `CH_CACHE_ENABLED` | `true` | |
| `CH_LOG_LEVEL` | `info` | |

### Tuning fair shares

Full table of what each caller gets at every crowd size, with the arithmetic:
[rate-limits.md](rate-limits.md#fair-shares).

The default reservation is an eighth of the effective window — 71 of 570.
Roughly: one `company_snapshot` costs 4, and 23 companies of a
`screen_companies` run cost 69.

- **A handful of heavy users** (batch screening): raise
  `CH_CLIENT_RESERVATION` so a whole run fits in one caller's share.
- **Many light users** (single lookups): lower it, so more callers fit.

A caller may exceed its reservation whenever the window has room — the
reservation is a floor under everyone else, not a ceiling on anyone. A lone
caller on a quiet server keeps 499 of the 570-request effective window: all of
it bar one reservation held back for whoever arrives next.

---

## What to expect when the budget runs out

Not an error, in the normal case. `screen_companies` checks the budget before
the expensive half, screens what fits, and returns the rest under
`not_screened` with the reset time — the guarantee from
[ADR 8](adr/0008-partial-results-and-budget-honesty.md). A table is never
quietly shorter than the list you sent.

A single call that cannot proceed within `CH_MAX_WAIT_MS` fails with
`RATE_LIMITED`, a retry time, and a suggestion to bring your own key.

---

## Checking a deployment actually works

Two requests, in order. The first needs no MCP knowledge and tells you the
process is up:

```bash
curl https://your-deployment/health
# {"status":"ok","version":"0.2.0"}
```

The second is a real MCP handshake:

```bash
curl -i -X POST https://your-deployment/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},
        "clientInfo":{"name":"curl","version":"1"}}}'
```

**The `Accept` header matters and is the single most likely thing to trip you
up.** Omit `text/event-stream` and the MCP SDK answers `406`, which looks
exactly like a broken deployment and is not one. Every real client sends both
types; only hand-written curl gets this wrong.

What a healthy response looks like differs by transport, and both are correct:

| | Node | Workers |
|---|---|---|
| Status | `200` | `200` |
| `Mcp-Session-Id` | issued | absent — the Worker is stateless |
| `Content-Type` | `text/event-stream` | `application/json` |

### When it does not work

| Symptom | Cause |
|---|---|
| `406` | `Accept` is missing `text/event-stream`. See above |
| `404` on `/mcp` | Wrong path. The endpoint is `/mcp`; `/` returns 404 by design |
| `403` | An `Origin` header was sent and is not in `CH_ALLOWED_ORIGINS`. Browsers send one; curl and MCP clients do not |
| `500` "The server is misconfigured" | A binding or variable is missing. The detail is deliberately not returned — read it in `wrangler tail` or your process logs |
| `405` on `GET /mcp` (Workers) | Expected. The Worker is stateless, so there is no stream to open |
| `/health` and `initialize` fine, but every tool call returns `NETWORK_ERROR` | The Worker cannot reach Companies House. Set `CH_LOG_LEVEL=debug`, redeploy, and read the underlying reason in `npx wrangler tail`. Note that a wrong or unset key gives `AUTH_INVALID`, not this — so the key is not the explanation |
| Everything 503s | The Durable Object cannot be reached. The limiter fails closed rather than spending the key blind |

`npx wrangler tail` streams live logs from a deployed Worker, which is where
the misconfiguration detail goes.

## Before you make it public

- **The Companies House terms do not address this — checked, August 2026.**
  Pooling one registered API key behind a service that serves third parties is
  neither prohibited nor explicitly permitted: there is no published usage
  policy specific to the public data API that speaks to it either way. The
  terms do prohibit other things by name, so the reasonable reading of a
  silence in that company is that pooling is not disallowed — but *unaddressed
  is not the same as approved*, and it is your account and your key at risk.
  If you want certainty rather than a reading, ask Companies House support
  before you publish, and re-check when they publish usage guidance. See
  [ADR 15](adr/0015-authless-now-oauth-ready.md).
- **Anyone with the URL can spend your budget.** That is the deal with an
  authless server. Fair sharing bounds what any one caller takes; it does not
  stop a determined one.
- **There is no way to ban an individual.** Authless means no durable
  identity. Your options are to lower the reservation, rotate the key, or
  implement the OAuth provider the `AuthProvider` seam exists for.
- **Put TLS in front of it.** The endpoint is plain HTTP.
- **If you put a reverse proxy in front, set `CH_TRUST_PROXY_HEADERS=true`.**
  Otherwise every caller arrives with the proxy's address, collapses into one
  identity, and shares a single reservation between them. Do *not* set it when
  the server is directly reachable: `X-Forwarded-For` is set by the caller, and
  a client that varies it per request would mint a fresh reservation each time
  and defeat fair sharing entirely. The same applies to `CF-Connecting-IP`:
  that header is only trustworthy inside Cloudflare's runtime, where the
  platform sets it and strips any client copy — arriving at a Node process it
  is just another header the caller typed, so it is gated by the same setting.
  The Workers deployment reads it from its own request and needs no setting.
