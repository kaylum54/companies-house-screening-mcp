# 12. The server speaks Streamable HTTP as well as stdio

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Until now this server only spoke stdio. Under stdio the client *spawns* the
server as a child process and talks to it over that process's stdin and
stdout. That implies four things about whoever wants to use it: they are on a
machine that can spawn processes, that machine has Node 22 or Docker, the MCP
host is running on that same machine, and they have their own Companies House
API key pasted into a host config file.

The third requirement is the expensive one. It excludes claude.ai on web and
mobile, ChatGPT connectors, hosted agent platforms, and every workflow tool
that runs server-side — all of which take a URL and have no laptop to spawn a
process on. The second requirement excludes the user this was built for: the
README's own example is somebody in procurement with forty new suppliers, and
that person is on a managed corporate laptop where they cannot install Node,
cannot run Docker, and should not be editing a JSON config file with a
JSON-RPC framing footgun in it.

Two further costs are specific to this server rather than general. The rate
limiter was per-process while the Companies House budget is per-key, so five
colleagues sharing a key had five limiters each believing it owned 570 of a
570-request window (ADR 2 acknowledged this and mitigated it with a margin).
And the cache — which ADR 4 argues is a feature rather than an optimisation —
was per-machine, so ten people screening overlapping supplier lists paid for
the same public data ten times.

## Decision

**Add Streamable HTTP; keep stdio exactly as it is.** The goal is to be usable
by everyone, and everyone includes the people already using it. stdio remains
the right answer for a local install: it needs no infrastructure, no hosting
bill and no operational attention. Nothing about `bin.ts` changed beyond
handing it a cache store.

**`createServer` stays transport-agnostic.** It builds an `McpServer` and
registers tools; it does not know what it is speaking over. This was already
true — the test harness has always driven it over an in-memory transport —
which is why adding a second transport was small. `tests/runtime-portability.test.ts`
asserts that `server.ts` contains no reference to a transport, so it stays
true.

**Three entry points, one server.** `bin.ts` for stdio, `http-bin.ts` for a
Node HTTP deployment, `cloudflare/worker.ts` for Workers. Each owns its
transport, its storage adapters and its process lifecycle; none owns any
behaviour.

**The Worker is stateless; the Node server is not.** A Worker isolate is
evicted whenever the platform likes, so a session held in isolate memory would
pass every test and vanish under load. Every tool here is request/response
with no server-initiated notifications, so a session buys nothing worth that
risk. The Node server keeps sessions because it can.

**Hardening appropriate to a public endpoint.** Origin allow-listing (no
Origin header means a non-browser client, which is every real MCP client, and
is admitted); a body ceiling answered from `Content-Length` before a byte is
read; loopback binding by default so that starting the server is not the same
as publishing it; and a wait ceiling on the rate limiter, because a limiter
that waits forever suits a CLI and hangs a server.

## Consequences

There is now something to operate. A hosted deployment has to run, be paid
for, be patched and be watched. That is a real cost and it is the reason stdio
was kept rather than replaced.

`RateLimiter.snapshot()` became async and `ResponseCache` takes a store rather
than a directory. Both are exported, so this is a breaking change to the
package's API — acceptable at 0.x, recorded in the CHANGELOG.

The API surface a hostile party can reach went from "nothing" to "an HTTP
endpoint". ADR 15 covers what is done about that.

Session identity is resolved once, at initialize, and bound for the session's
life. A caller bringing their own key must therefore send the header on the
initialize request. Every client that can set headers sets them on all
requests, so this has no practical cost, but it is a real constraint and is
documented in the deployment guide.
