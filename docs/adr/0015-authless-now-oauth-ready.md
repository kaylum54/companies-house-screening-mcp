# 15. Authless now, with the seam OAuth will need

- **Status:** accepted
- **Date:** 2026-08-24

## Context

The hosted server holds the operator's API key and is meant to be plug and
play: paste a URL into a client and it works. Anthropic's own documentation
says claude.ai custom connectors support both authless servers and OAuth 2.1
with dynamic client registration; separately, issue reports against the
connector UI indicate it does not offer a way to set an arbitrary
`Authorization` header. If that second point is right — and it is the weaker of
the two, so it is worth re-checking — a static bearer token is not an option
for the clients that matter most. Both statements describe someone else's
product as of August 2026 and may age.

That leaves a genuine choice between an authless URL, which anyone who finds
it can use against the operator's budget, and OAuth 2.1, which is real work —
an authorization server, token issuance and validation, and RFC 9728 protected
resource metadata for discovery.

The two are not equally urgent. Nothing behind this endpoint is confidential:
every tool reads the public register, there is no write path, and there is no
per-caller data to leak. What is at risk is *capacity* — the operator's 600
requests per five minutes — and reputation for whatever their key is used for.

## Decision

**Ship authless, and treat identity as a separate concern from
authentication.** `AuthProvider` resolves a request to a `ClientIdentity`;
everything downstream consumes that identity and never asks how it was
established. `NoAuthProvider` admits everyone and still tells them apart.

Adding OAuth later means implementing one interface, not rewriting the
limiter, the session factory and three entry points.

**Identity is derived from the caller's own key if they supplied one, and
otherwise from the peer address.** Neither is stored in the clear; both are
fingerprinted. Identities are prefixed by how they were derived (`key:`,
`ip:`, later `sub:`) so two schemes can never collide.

**The peer address is a budgeting principal, never an authorisation one.** It
is weak: a NAT groups strangers together, `X-Forwarded-For` is
caller-controlled, and anyone determined can move between addresses. It is
used because fair sharing needs *some* partition of callers and this is the
best one available before a caller has proved anything. The worst a forged
value achieves is a reservation of its own, which is also what opening a
second connection achieves.

**Defence sized to what is actually at risk.** The fair-share limiter is the
main control: it caps what any one caller can take. Alongside it, a body
ceiling, an Origin allow-list, a bounded number of tracked identities so a
burst of fabricated ones cannot grow memory without limit, and loopback
binding by default.

**A pressure valve instead of a paywall.** Any caller who finds the shared
budget too tight can bring their own key and get a private window. The
`RATE_LIMITED` message says so.

## Consequences

Anyone who finds the URL can spend the operator's budget. That is the accepted
cost of plug and play, bounded by fair shares, and reversible: setting
`CH_ALLOW_CLIENT_KEYS` and putting an OAuth provider in front changes the
posture without changing the server.

There is no way to ban an individual abuser, because there is no durable
identity to ban. The available responses are to lower the reservation, to
rotate the key, or to implement the OAuth provider this seam exists for. An
operator running this publicly should expect to want the third eventually.

Pooling one registered API key to serve arbitrary third parties is not
addressed by the Companies House developer terms. Checked in August 2026:
there is no published usage policy specific to the public data API, and
nothing in the terms prohibits it. Since those terms do prohibit other things
explicitly, the reading taken here is that pooling is permitted by omission —
but that is a reading, not a permission, and it is the operator's own account
and key that carry the consequence. Anyone deploying this should satisfy
themselves, and re-check if Companies House publishes usage guidance.

Nothing here depends on that answer holding. If pooling is ever disallowed,
the bring-your-own-key and self-hosted stdio paths become the primary ones and
the same code serves them unchanged — which is most of why the credential is
the unit of partition rather than the session.
