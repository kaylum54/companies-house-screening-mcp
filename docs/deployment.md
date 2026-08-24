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

**Do not put the API key in `[vars]`.** Vars are plain text in the dashboard
and in your repository. Use `wrangler secret put`.

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

**claude.ai's connector UI cannot set custom headers.** Those users should run
the server themselves over stdio, which gives them their own budget and has
always worked.

The key is read once, never logged, never cached, never returned in a tool
result, and never reaches the model. A malformed value is treated as absent
rather than passed into an auth header.

---

## Configuration

Everything is environment variables. Only the first is required.

| Variable | Default | Notes |
|---|---|---|
| `COMPANIES_HOUSE_API_KEY` | — | Required. A secret. |
| `CH_HTTP_HOST` | `127.0.0.1` | Set to `0.0.0.0` to accept external connections |
| `CH_HTTP_PORT` | `8787` | |
| `CH_ALLOWED_ORIGINS` | empty | Comma-separated. Only affects browsers; MCP clients send no Origin |
| `CH_MAX_REQUEST_BYTES` | `1048576` | Body ceiling |
| `CH_CLIENT_RESERVATION` | effective limit ÷ 8 | Requests each caller is always guaranteed |
| `CH_NEWCOMER_ALLOWANCE` | `1` | How many unseen callers to hold a reservation for |
| `CH_MAX_TRACKED_CLIENTS` | `10000` | Bound on identities tracked for fair sharing |
| `CH_ALLOW_CLIENT_KEYS` | `true` | Whether callers may bring their own key |
| `CH_TRUST_PROXY_HEADERS` | `false` | Believe `X-Forwarded-For` / `CF-Connecting-IP` when identifying callers. Turn on **only** behind a proxy you control |
| `CH_MAX_SESSIONS` | `1000` | Open sessions kept before the least recently used is evicted |
| `CH_SESSION_IDLE_MS` | `1800000` | How long a session may idle before being swept |
| `CH_MAX_WAIT_MS` | `60000` | How long a request waits for budget before `RATE_LIMITED` |
| `CH_RATE_LIMIT` | `600` | Lower it if the key is shared with something else |
| `CH_CACHE_ENABLED` | `true` | |
| `CH_LOG_LEVEL` | `info` | |

### Tuning fair shares

The default reservation is an eighth of the effective window — 71 of 570.
Roughly: one `company_snapshot` costs 4, and 23 companies of a
`screen_companies` run cost 69.

- **A handful of heavy users** (batch screening): raise
  `CH_CLIENT_RESERVATION` so a whole run fits in one caller's share.
- **Many light users** (single lookups): lower it, so more callers fit.

A caller may exceed its reservation whenever the window has room — the
reservation is a floor under everyone else, not a ceiling on anyone. A lone
caller on a quiet server keeps roughly 90% of the budget.

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

## Before you make it public

- **Check the Companies House developer terms.** Pooling one personal API key
  to serve arbitrary third parties may not be permitted. It is your account
  and your key at risk. See [ADR 15](adr/0015-authless-now-oauth-ready.md).
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
