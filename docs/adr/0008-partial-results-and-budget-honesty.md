# 8. Partial results are returned, and nothing is dropped quietly

- **Status:** accepted
- **Date:** 2026-08-20

## Context

The composite tools fan out. `company_snapshot` makes up to four requests for
one company; `screen_companies` makes up to four per company across as many as
fifty. Three things can go wrong part-way through, and each has a lazy answer
that is worse than it looks:

1. One section fails. Lazy answer: fail the whole call.
2. A name matches several companies. Lazy answer: take the first result.
3. The rate-limit budget runs out mid-run. Lazy answer: stop, return what you
   have, say nothing.

The third is the dangerous one. A screening table that silently stops at row
nineteen of thirty looks exactly like a screening table where eleven companies
were clean.

## Decision

**Partial snapshots are returned, and say what is missing.** If charges cannot
be read, the snapshot still carries the profile, the officers and the
insolvency history, and `sections_unavailable` records the section, the error
code and the message. `sections_included` lists what was actually read, so a
missing signal can be told apart from a section nobody looked at.

**A 404 on charges or insolvency is not a failure.** It is how Companies House
says the company has none. Recording it as an outage would put an alarming
"unavailable" note on every clean company on the register. Those sections come
back as zero counts and the section counts as included.

**A 404 on the profile is fatal.** The company does not exist, and every other
section would be about nothing.

**The profile is fetched first, alone.** Firing all four sections at once
saves a round trip on the happy path and spends four requests instead of one
every time somebody mistypes a number. With a budget of 600 per five minutes
and a rate limiter that serialises acquisition anyway, the round trip is the
cheaper thing to give up.

**Batch resolution never guesses.** A name that matches several companies with
no exact match becomes an `unresolved` row carrying its candidates. The rule
from ADR 5 applies with more force here: thirty rows are read as a table and
nobody re-checks row nineteen.

**Budget is checked before the expensive half, and shortfalls are named.**
`screen_companies` works out how many companies it can afford, screens those,
and returns the rest under `not_screened` with a reason that includes how long
until the window resets. A company that failed mid-run lands there too.
`screened.length + not_screened.length + unresolved.length` accounts for every
deduplicated input.

## Consequences

The output shapes are wider than they would be otherwise: three separate
arrays instead of one. That is the cost of the guarantee, and the guarantee is
worth more than the tidiness.

A caller that ignores `not_screened` and `unresolved` gets exactly the silent
truncation this decision was meant to prevent. Mitigated by naming both in the
tool description and the server instructions, and by giving `screen_companies`
a `requested` count that will not match `screened.length` when anything was
left out.

The 50-input cap is arbitrary and deliberately low. It is a guard against
somebody pasting an entire customer list into one call and discovering the
rate limit the hard way, and it can be raised once there is a reason to.
