# 1. Record architecture decisions

- **Status:** accepted
- **Date:** 2026-08-20

## Context

Most of the choices in this codebase are not obvious from reading it. Why the
rate limiter is a sliding window rather than a token bucket, why retrieval
tools refuse company names, why the cache serves expired data during an
outage — all of these look arbitrary six months later, and the usual result is
that somebody "simplifies" one of them back into the bug it was written to
avoid.

## Decision

Every decision with a real alternative gets a short record here, written when
the decision is made rather than reconstructed afterwards. The format is
context, decision, consequences. Records are numbered, immutable once
accepted, and superseded rather than edited.

## Consequences

Writing one costs about ten minutes. In exchange, a reviewer can see the
reasoning without asking, and a future change that contradicts a record has to
argue with it first.

Records that turn out to be wrong are marked superseded, with a pointer to the
record that replaced them. The wrong reasoning stays visible, because knowing
what was believed at the time is the useful part.
