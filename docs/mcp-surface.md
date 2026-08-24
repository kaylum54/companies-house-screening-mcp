# The MCP surface

What this server implements, what it does not, and how it behaves on each
transport. Everything below was read off the running server rather than
described from intent; where a number or a field name appears, it came from an
actual `initialize` exchange against this code.

## What the server advertises

From a real `initialize` against both transports:

| | |
|---|---|
| Server name | `companies-house` |
| Protocol version | `2025-06-18` |
| Capabilities | `{"tools": {"listChanged": true}}` |
| Instructions | Yes — around 2,500 characters, sent once at initialisation |

**Tools are the only capability.** There are no MCP resources, no prompts, no
sampling and no completions. That is a deliberate scope, not an omission: every
question this server answers is a lookup with arguments, which is what a tool
is for. A host that expects resources will find none and should not wait for
them.

`listChanged: true` is what the SDK advertises for a tool registry; in
practice this server registers its tools once at construction and never
changes them mid-session, so the notification is never sent.

### Instructions

The server sends a block of instructions at initialisation rather than
repeating the same guidance across eleven tool descriptions. It carries the
read-only rule, when to prefer the composite tools, the "never guess a company
number" rule, how to read `signals`, and the Open Government Licence
attribution. Cost is paid once per session instead of once per call. The text
lives in `INSTRUCTIONS` in `src/server.ts`.

## Tools

Eleven, in two groups. Full reference with schemas and worked examples in
[docs/tools](tools/README.md), generated from the running server and gated in
CI — see [ADR 9](adr/0009-documentation-is-generated-and-gated.md).

**Composite** — answer a whole question in one call:

- `company_snapshot` — one company: profile, serving officers, outstanding
  charges, insolvency, plus derived signals. Costs **4** upstream requests.
- `screen_companies` — up to 50 companies, one row each. Costs **3** upstream
  requests per company by default (officers are excluded unless asked for), so
  a full 50-company run is **150** requests.

**Primitive** — when you need the full list rather than a summary:
`find_company`, `find_officer`, `get_company`, `get_officers`, `get_charges`,
`get_psc`, `get_insolvency`, `get_filing_history`, `get_officer_appointments`.

Those request costs are measured, not estimated: `tests/` exercises the tools
against recorded fixtures and counts the calls.

### There is no write path

Every tool reads the public register. Nothing files, submits, updates or
deletes, and no Companies House write API is reachable from this server. The
instructions state this in their first line because a model asked to "file a
confirmation statement" would otherwise call a read tool and present it as
progress.

## Results and errors

Every successful result carries the same payload twice: as `content` text and
as `structuredContent`. Hosts that understand structured output read the
latter; the rest get readable JSON either way. See
[ADR 6](adr/0006-duplicated-result-payload.md).

Errors come back as tool results with `isError: true` and a structured body —
a code, a message, a suggested next step, and a retry hint where one applies —
rather than as JSON-RPC protocol errors. A failed lookup is an answer about the
register, not a transport fault, and a model can act on it. See
[ADR 3](adr/0003-errors-are-data.md).

Every successful response carries a `meta` block. In full:

| Field | Meaning |
|---|---|
| `rate_limit_remaining` | Requests this caller may still make in the window |
| `rate_limit_resets_in_ms` | Milliseconds until more budget frees up |
| `cached` | True when every underlying request was served without contacting Companies House |
| `stale` | True when any part was served from an expired cache entry after an upstream failure |
| `age_seconds` | Age of the oldest cached part. Absent when nothing was cached |
| `licence` | Always `OGL-v3.0` |

`rate_limit_remaining` is what a long run should pace itself against.
`screen_companies` does this internally: it asks the budget before the
expensive half, screens what fits, and returns the rest under `not_screened`
with a reason — so a table is never quietly shorter than the list you sent. See
[ADR 8](adr/0008-partial-results-and-budget-honesty.md).

## Transports

All three run the same server object; only the wiring differs.

### stdio

The client spawns the process and talks over stdin/stdout. Nothing may write
to stdout but the transport — diagnostics go to stderr. Session state lives in
the process for as long as it runs.

Rate limiting waits for the window rather than giving up, which is what a
single local caller wants. `CH_MAX_WAIT_MS` imposes a ceiling if you want one.

### Streamable HTTP (Node)

`POST /mcp` for requests, `GET /mcp` for the notification stream, `DELETE /mcp`
to end a session. **Stateful**: the server issues an `Mcp-Session-Id` on
initialize and requires it on every subsequent request. Unknown or expired
session ids get `404`; a non-initialize request with no session id gets `400`.

There is also `GET /health`, which returns `{"status":"ok","version":"..."}`
and deliberately reveals nothing about the budget or the key.

Sessions are swept when idle (`CH_SESSION_IDLE_MS`) and the least recently used
is evicted at `CH_MAX_SESSIONS`.

### Streamable HTTP (Cloudflare Workers)

**Stateless**: no `Mcp-Session-Id` is issued and none is required. Each request
builds a server, answers, and is discarded. Responses are plain
`application/json` rather than SSE.

This is not a compromise — a Worker isolate is evicted whenever the platform
chooses, so a session held in isolate memory would pass every test and vanish
under load. Every tool here is request/response with no server-initiated
notifications, so a session buys nothing worth that risk.

Because there is nothing to stream and no session to delete, `GET` and
`DELETE` are answered `405` with `Allow: POST`, before any work is done.

What is *not* stateless is the part that must not be: the rate-limit window
lives in a Durable Object and the response cache in KV, both shared across
every isolate. See [ADR 12](adr/0012-remote-transport-alongside-stdio.md).

## Sessions, identity and budgets

On the hosted transports each caller is resolved to an identity, and that
identity decides whose budget a request spends:

- **No key supplied** → the caller joins the pooled budget on the operator's
  key, with a guaranteed share of it.
- **`X-Companies-House-Api-Key` supplied** → a private window on that key, with
  fair-sharing switched off since nobody else can reach it.
- **The operator's own key supplied** → treated as pooled. It is the same
  credential, and Companies House meters credentials.

The response cache is shared by everyone regardless, because the register is
public and a profile fetched with one key is identical to one fetched with
another. Budgets are partitioned; the cache is not. See
[ADR 13](adr/0013-one-key-shared-budget-fair-shares.md).

Identity is resolved once, at `initialize`, and bound for the life of the
session — so a client bringing its own key must send the header on the
initialize request. Every client that can set headers sets them on all
requests, so this costs nothing in practice.

## Authentication

None, today. The endpoint admits everybody and tells them apart for
budgeting only. `AuthProvider` is the seam an OAuth implementation drops into
without touching the limiter or the entry points. What that means for an
operator, and what is genuinely at risk, is in
[ADR 15](adr/0015-authless-now-oauth-ready.md) and the
[deployment guide](deployment.md#before-you-make-it-public).

## Data licence

Companies House data is published under the Open Government Licence v3.0. When
reproducing it, include:

> Contains public sector information licensed under the Open Government
> Licence v3.0.

The server states this in its instructions so the attribution reaches the model
once per session rather than once per response.
