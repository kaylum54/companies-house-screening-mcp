# 3. Errors are data, not exceptions

- **Status:** accepted
- **Date:** 2026-08-20

## Context

When a tool fails, the failure is read by a language model, not by a person
with a debugger. A stack trace serialised into a tool result gives the model
nothing to act on. What it does next is one of two things, and both are bad:
it retries the identical call, burning rate-limit budget on a request that
cannot succeed; or it stops using the tool and answers from memory, which in
this domain means inventing company details.

The Companies House API also overloads its status codes. A 404 means both
"this company does not exist" and "this company exists and has nothing filed
under this section". Those want different responses.

## Decision

Every failure becomes a `CompaniesHouseError` carrying three fields:

- `code` — stable, machine-readable, safe to branch on.
- `message` — one plain sentence. No stack, no jargon, no upstream HTML.
- `nextStep` — what to do instead, phrased as an instruction.

`nextStep` is the field that changes behaviour, and it is mandatory. "No
company with that number" leaves a model stuck. "No company with that number,
search by name with find_company" does not.

Errors also carry `retryable`, which the client uses to decide whether to try
again and whether serving an expired cache entry is honest. A 401 is not
retryable and says so in its next step: *retrying will not fix it*.

## Consequences

Writing an error takes longer than throwing one, and the test suite asserts
that every error has a next step of some length. That assertion has already
caught two errors that were written as dead ends.

The error surface is now part of the public contract. Changing a code is a
breaking change, and it is versioned as one.
